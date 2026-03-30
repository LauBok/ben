(function() {
    'use strict';

    // === Constants ===
    var API_PORT = 8080;
    var WS_PORT = 4443;

    // When accessed via ngrok/reverse proxy, WS connects to same host on default port
    var _isRemote = location.hostname !== 'localhost' && location.hostname !== '127.0.0.1';
    function buildWsUrl(port, queryParams) {
        var protocol = location.protocol === 'https:' ? 'wss://' : 'ws://';
        var host = _isRemote ? location.host : location.hostname + ':' + port;
        return protocol + host + '/?' + queryParams.join('&');
    }
    function buildApiBase() {
        if (_isRemote) return location.protocol + '//' + location.host;
        return location.protocol + '//' + location.hostname + ':' + API_PORT;
    }
    var SUIT_LETTERS = 'SHDC';
    var SUIT_SYMBOLS = ['\u2660', '\u2665', '\u2666', '\u2663'];
    var SUIT_CLASSES = ['bp-suit-s', 'bp-suit-h', 'bp-suit-d', 'bp-suit-c'];
    var PC_CLASSES = ['bp-pc-s', 'bp-pc-h', 'bp-pc-d', 'bp-pc-c'];
    var RANKS = 'AKQJT98765432';
    var SEAT_LABELS = ['North', 'East', 'South', 'West'];

    // Seat rotation for multiplayer: maps absolute seat index to display position.
    // Display positions: 0=top(north), 1=right(east), 2=bottom(south), 3=left(west).
    // In multiplayer, the player's own seat always appears at position 2 (bottom/south).
    function displayPos(seatIdx) {
        if (!G.multiplayer || G.mySeat < 0 || G.mySeat === 2) return seatIdx;
        return (seatIdx - G.mySeat + 6) % 4;
    }

    // === Data Classes ===

    function Card(symbol) {
        this.symbol = symbol;
        this.suit = SUIT_LETTERS.indexOf(symbol[0]);
        this.rank = symbol[1];
        this.value = RANKS.indexOf(symbol[1]);
    }

    function Hand(cards, isPublic) {
        this.cards = cards || [];
        this.isPublic = isPublic || false;
        this.suits = [[], [], [], []];
        this._updateSuits();
    }
    Hand.prototype._updateSuits = function() {
        this.suits = [[], [], [], []];
        for (var i = 0; i < this.cards.length; i++) {
            this.suits[this.cards[i].suit].push(this.cards[i]);
        }
    };
    Hand.prototype.setCards = function(cards) {
        this.cards = cards;
        this._updateSuits();
    };
    Hand.prototype.hasCard = function(card) {
        for (var i = 0; i < this.cards.length; i++) {
            if (this.cards[i].symbol === card.symbol) return true;
        }
        return false;
    };
    Hand.prototype.isPlayable = function(card, trick) {
        if (!this.hasCard(card)) return false;
        if (trick.cards.length === 0) return true;
        if (trick.cards.length >= 4) return false;
        var leadSuit = trick.cards[0].suit;
        if (this.suits[leadSuit].length === 0) return true;
        return card.suit === leadSuit;
    };
    Hand.prototype.play = function(card) {
        var remaining = [];
        for (var i = 0; i < this.cards.length; i++) {
            if (this.cards[i].symbol !== card.symbol) remaining.push(this.cards[i]);
        }
        var h = new Hand(remaining, this.isPublic);
        return h;
    };

    function parseHand(pbn) {
        var suits = pbn.split('.');
        var cards = [];
        for (var i = 0; i < suits.length && i < 4; i++) {
            for (var j = 0; j < suits[i].length; j++) {
                cards.push(new Card(SUIT_LETTERS[i] + suits[i][j]));
            }
        }
        return cards;
    }

    function Trick(leadPlayer, cards) {
        this.leadPlayer = leadPlayer;
        this.cards = cards || [];
    }
    Trick.prototype.isComplete = function() { return this.cards.length === 4; };
    Trick.prototype.winner = function(strain) {
        if (!this.isComplete()) return -1;
        var trump = strain - 1; // 0=S,1=H,2=D,3=C; -1 for NT
        var trumpPlayed = false;
        var i;
        if (trump >= 0) {
            for (i = 0; i < this.cards.length; i++) {
                if (this.cards[i].suit === trump) { trumpPlayed = true; break; }
            }
        }
        var bestVal = 100, bestIdx = -1;
        if (trumpPlayed) {
            for (i = 0; i < this.cards.length; i++) {
                if (this.cards[i].suit !== trump) continue;
                if (this.cards[i].value < bestVal) { bestVal = this.cards[i].value; bestIdx = i; }
            }
        } else {
            var led = this.cards[0].suit;
            for (i = 0; i < this.cards.length; i++) {
                if (this.cards[i].suit !== led) continue;
                if (this.cards[i].value < bestVal) { bestVal = this.cards[i].value; bestIdx = i; }
            }
        }
        return (this.leadPlayer + bestIdx) % 4;
    };

    // === Game State ===
    var G = {
        ws: null,
        phase: 'setup',
        dealer: 0,
        vuln: [false, false],
        hands: [null, null, null, null],
        auction: [],
        turn: 0,
        tricks: [],
        currentTrick: null,
        tricksCount: [0, 0],
        declarer: -1,
        dummy: -1,
        strain: -1,
        boardNo: '',
        expectBidInput: false,
        expectCardInput: false,
        expectTrickConfirm: false,
        canDouble: false,
        canRedouble: false,
        humanSeats: [false, false, true, false],
        noHuman: false,
        selectedLevel: null,
        autoTimeoutId: null,
        lastTrick: null,
        visible: false,
        reviewDict: null,
        reviewTrickIdx: 0,
        mode: null, // 'bidding', 'playing', 'free', or null
        bidExplanations: [], // explanation per non-PAD_START bid
        bidPreviews: {},      // {bidStr: explanation} for valid bids at current turn
        // 复盘 (replay from position) state
        replayCards: null,    // array of card symbols to auto-play, or null
        replayIdx: 0,         // next index in replayCards to auto-play
        replayMode: false,    // true while in 复盘 exploration
        savedReviewDict: null, // saved review for returning
        // Multiplayer state
        multiplayer: false,   // true when in a multiplayer game
        roomId: null,
        mySeat: -1,           // absolute seat index (0=N, 1=E, 2=S, 3=W)
        mpHumanSeats: '',     // e.g. 'NES'
        // Session state (multi-board)
        sessionMode: null,    // 'casual', 'dual', 'match2v2', 'match4v4'
        sessionBoardIdx: 0,
        sessionTotalBoards: 0,
        sessionResults: [],
        cumulativeScoreNS: 0,
        cumulativeScoreEW: 0,
        cumulativeIMPs: 0,
        sessionEnded: false,
        lastDualResult: null
    };

    // === Helpers ===
    function $(sel) { return document.querySelector(sel); }
    var _loaderTimeout = null;
    function show(el) {
        if (typeof el === 'string') {
            if (el === '#bp-loader') {
                clearTimeout(_loaderTimeout);
                _loaderTimeout = setTimeout(function() {
                    var ldr = $(el);
                    if (ldr) ldr.style.display = '';
                }, 2000);
                return;
            }
            el = $(el);
        }
        if (el) el.style.display = '';
    }
    function hide(el) {
        if (typeof el === 'string') {
            if (el === '#bp-loader') { clearTimeout(_loaderTimeout); }
            el = $(el);
        }
        if (el) el.style.display = 'none';
    }

    function setStatus(text) {
        var el = document.getElementById('bp-status');
        if (el) el.textContent = text || '';
    }

    function getMinBiddableLevel(bids) {
        for (var i = bids.length - 1; i >= 0; i--) {
            var lev = parseInt(bids[i][0]);
            if (isNaN(lev)) continue;
            if (bids[i][1] === 'N') return lev + 1;
            return lev;
        }
        return 1;
    }
    function getMinBiddableSuit(bids, level) {
        for (var i = bids.length - 1; i >= 0; i--) {
            var lev = parseInt(bids[i][0]);
            if (isNaN(lev)) continue;
            if (lev < level) return 0;
            return 'CDHSN'.indexOf(bids[i][1]) + 1;
        }
        return 0;
    }

    function formatBid(bid) {
        if (!bid || bid === 'PAD_START') return '';
        if (bid === 'Pass' || bid === 'PASS' || bid === 'P') return 'Pass';
        if (bid === 'X') return '<span class="bp-bid-suit-h">X</span>';
        if (bid === 'XX') return '<span class="bp-bid-suit-d">XX</span>';
        var lev = bid[0];
        var s = bid[1];
        var map = {
            'N': 'NT',
            'S': '<span class="bp-bid-suit-s">\u2660</span>',
            'H': '<span class="bp-bid-suit-h">\u2665</span>',
            'D': '<span class="bp-bid-suit-d">\u2666</span>',
            'C': '<span class="bp-bid-suit-c">\u2663</span>'
        };
        return lev + (map[s] || s);
    }

    // --- Contract parsing & bridge scoring helpers ---

    function parseContract(str) {
        // Parse "2SXS", "2HW", "4SS", "3NE", "3NXXW" → {level, strain, strainIdx, doubled, declarer, declarerIdx}
        if (!str || str === 'All Pass') return null;
        var m = str.match(/^(\d)([CDHSN])(X{0,2})([NESW])$/);
        if (!m) return null;
        var strainMap = {S: 0, H: 1, D: 2, C: 3, N: 4};
        var declMap = {N: 0, E: 1, S: 2, W: 3};
        return {
            level: parseInt(m[1]),
            strain: m[2],
            strainIdx: strainMap[m[2]],
            doubled: m[3].length,
            declarer: m[4],
            declarerIdx: declMap[m[4]]
        };
    }

    function parseParDisplay(parDisplay) {
        // "4H by EW (EW +420)" → {level, strainIdx, side}
        if (!parDisplay) return null;
        var m = parDisplay.match(/^(\d)(NT|[CDHSN])x{0,2}\s+by\s+(NS|EW)/);
        if (!m) return null;
        var strainMap = {S: 0, H: 1, D: 2, C: 3, N: 4, NT: 4};
        return { level: parseInt(m[1]), strainIdx: strainMap[m[2]], side: m[3] };
    }

    function ddLookup(ddTable, strainIdx, declarerIdx) {
        if (!ddTable || !ddTable[strainIdx]) return null;
        return ddTable[strainIdx][declarerIdx];
    }

    function computeBridgeScore(level, strainIdx, tricks, vul, doubled) {
        var needed = level + 6;
        var diff = tricks - needed;
        if (diff >= 0) {
            var perTrick = strainIdx <= 1 ? 30 : strainIdx <= 3 ? 20 : 30;
            var basePts = level * perTrick + (strainIdx === 4 ? 10 : 0);
            var dblMul = doubled === 0 ? 1 : doubled === 1 ? 2 : 4;
            var contractPts = basePts * dblMul;
            var score = contractPts;
            score += contractPts >= 100 ? (vul ? 500 : 300) : 50;
            if (level === 6) score += vul ? 750 : 500;
            if (level === 7) score += vul ? 1500 : 1000;
            if (doubled === 1) score += 50;
            if (doubled === 2) score += 100;
            if (diff > 0) {
                if (doubled === 0) score += diff * perTrick;
                else if (doubled === 1) score += diff * (vul ? 200 : 100);
                else score += diff * (vul ? 400 : 200);
            }
            return score;
        } else {
            var under = -diff;
            var penalty = 0;
            if (doubled === 0) {
                penalty = under * (vul ? 100 : 50);
            } else {
                for (var i = 1; i <= under; i++) {
                    if (vul) penalty += i === 1 ? 200 : 300;
                    else penalty += i === 1 ? 100 : i <= 3 ? 200 : 300;
                }
                if (doubled === 2) penalty *= 2;
            }
            return -penalty;
        }
    }

    function nsScore(parsed, tricks, vulNS, vulEW) {
        // Compute score from NS perspective
        if (!parsed) return 0;
        var declIsNS = parsed.declarerIdx === 0 || parsed.declarerIdx === 2;
        var vul = declIsNS ? vulNS : vulEW;
        var raw = computeBridgeScore(parsed.level, parsed.strainIdx, tricks, vul, parsed.doubled);
        return declIsNS ? raw : -raw;
    }

    function formatScore(score) {
        if (score === null || score === undefined) return '-';
        var cls = score > 0 ? 'bp-score-pos' : score < 0 ? 'bp-score-neg' : 'bp-score-zero';
        var str = score > 0 ? '+' + score : '' + score;
        return '<span class="' + cls + '">' + str + '</span>';
    }

    function formatDDResult(tricks, level) {
        if (tricks === null || tricks === undefined) return '-';
        var needed = level + 6;
        var diff = tricks - needed;
        var tag = diff === 0 ? '=' : diff > 0 ? '+' + diff : '' + diff;
        var cls = diff >= 0 ? 'bp-score-pos' : 'bp-score-neg';
        return '<span class="' + cls + '">' + tricks + ' (' + tag + ')</span>';
    }

    // Format contract text for display
    // BEN format: "6CW" = 6♣ by W, "4HXS" = 4♥X by S, "3NN" = 3NT by N
    // Par format: "5D by NS (NS +660)"
    var SUIT_HTML = {
        'C': '<span class="bp-bid-suit-c">\u2663</span>',
        'D': '<span class="bp-bid-suit-d">\u2666</span>',
        'H': '<span class="bp-bid-suit-h">\u2665</span>',
        'S': '<span class="bp-bid-suit-s">\u2660</span>'
    };
    function formatContractText(text) {
        if (!text) return '';
        // BEN contract: "6CW", "4HXS", "3NE", "3NXXW"
        // Pattern: digit + strain + optional X/XX + direction(NESW)
        return text.replace(/(\d)([CDHSN])(X{0,2})([NESW])(?=[\s\(\),]|$)/g, function(m, lev, strain, dbl, decl) {
            var strainDisp = strain === 'N' ? 'NT' : (SUIT_HTML[strain] || strain);
            return lev + strainDisp + (dbl || '') + ' by ' + decl;
        }).replace(/(\d)([CDHS])(?=[x\s\(]|$)/g, function(m, lev, suit) {
            // Par format fallback: "5D by NS"
            return lev + (SUIT_HTML[suit] || suit);
        });
    }

    // === Bid Explanation Tooltip ===

    function formatExplanation(raw) {
        if (!raw) return '';
        // Replace BBA suit markers with colored Unicode symbols
        var html = raw
            .replace(/!S/g, '<span class="bp-bid-suit-s">\u2660</span>')
            .replace(/!H/g, '<span class="bp-bid-suit-h">\u2665</span>')
            .replace(/!D/g, '<span class="bp-bid-suit-d">\u2666</span>')
            .replace(/!C/g, '<span class="bp-bid-suit-c">\u2663</span>');

        // Split on " -- " separator
        var parts = html.split(' -- ');
        var meaning = parts[0] ? parts[0].trim() : '';
        var details = parts[1] ? parts[1].trim() : '';

        // Filter trivial constraints (7- suit = up to 7, always true)
        if (details) {
            var items = details.split('; ');
            var filtered = [];
            for (var i = 0; i < items.length; i++) {
                var item = items[i].trim();
                // Skip "7-♣" style trivials and empty items
                if (!item || /^7-\s*<span/.test(item)) continue;
                filtered.push(item);
            }
            details = filtered.join('; ');
        }

        var result = '';
        if (meaning) result += '<span class="bp-tip-meaning">' + meaning + '</span>';
        if (meaning && details) result += ' — ';
        if (details) result += '<span class="bp-tip-details">' + details + '</span>';
        return result;
    }

    var tipEl = null;
    function showBidTip(target, html) {
        if (!tipEl) {
            tipEl = document.createElement('div');
            tipEl.className = 'bp-bid-tooltip';
            document.body.appendChild(tipEl);
        }
        tipEl.innerHTML = html;
        tipEl.style.display = 'block';
        var rect = target.getBoundingClientRect();
        tipEl.style.left = rect.left + 'px';
        tipEl.style.top = (rect.bottom + 4) + 'px';
        // Keep tooltip within viewport
        requestAnimationFrame(function() {
            var tipRect = tipEl.getBoundingClientRect();
            if (tipRect.right > window.innerWidth - 8) {
                tipEl.style.left = (window.innerWidth - tipRect.width - 8) + 'px';
            }
        });
    }

    function hideBidTip() {
        if (tipEl) tipEl.style.display = 'none';
    }

    // === Rendering ===

    function renderHand(hand, elId, canClick) {
        var el = document.getElementById(elId);
        el.innerHTML = '';
        el.classList.remove('bp-hidden');

        if (!hand || !hand.isPublic || hand.cards.length === 0) {
            el.classList.add('bp-hidden');
            return;
        }

        // Sort by suit order based on strain (trump first)
        var order = [0, 1, 2, 3];
        if (G.strain === 1) order = [0, 1, 3, 2];
        if (G.strain === 2) order = [1, 0, 3, 2];
        if (G.strain === 3) order = [2, 0, 1, 3];
        if (G.strain === 4) order = [3, 1, 0, 2];

        // Determine which cards are playable (for dimming)
        var playableCards = {};
        if (canClick && G.currentTrick) {
            for (var ci2 = 0; ci2 < hand.cards.length; ci2++) {
                if (hand.isPlayable(hand.cards[ci2], G.currentTrick)) {
                    playableCards[hand.cards[ci2].symbol] = true;
                }
            }
        }

        for (var oi = 0; oi < order.length; oi++) {
            var si = order[oi];
            var row = document.createElement('div');
            row.className = 'bp-suit-row';

            var sym = document.createElement('span');
            sym.className = 'bp-suit-symbol ' + SUIT_CLASSES[si];
            sym.textContent = SUIT_SYMBOLS[si];
            row.appendChild(sym);

            if (hand.suits[si].length === 0) {
                var dash = document.createElement('span');
                dash.className = 'bp-card';
                dash.textContent = '\u2014';
                row.appendChild(dash);
            } else {
                for (var ci = 0; ci < hand.suits[si].length; ci++) {
                    var card = hand.suits[si][ci];
                    var span = document.createElement('span');
                    span.className = 'bp-card ' + SUIT_CLASSES[si];
                    if (canClick) {
                        if (playableCards[card.symbol]) {
                            span.classList.add('bp-clickable');
                        } else {
                            span.classList.add('bp-dimmed');
                        }
                    }
                    span.textContent = card.rank;
                    span.setAttribute('data-symbol', card.symbol);
                    row.appendChild(span);
                }
            }
            el.appendChild(row);
        }

        if (canClick) {
            el.querySelectorAll('.bp-clickable').forEach(function(c) {
                c.addEventListener('click', onCardClick);
            });
        }
    }

    function renderAllHands() {
        var els = ['bp-north', 'bp-east', 'bp-south', 'bp-west'];
        var labelIds = ['bp-label-n', 'bp-label-e', 'bp-label-s', 'bp-label-w'];
        for (var i = 0; i < 4; i++) {
            var dPos = displayPos(i);
            var visible = shouldShowHand(i);
            var canClick = visible && G.expectCardInput && isPlayerTurn(i);
            var labelEl = document.getElementById(labelIds[dPos]);
            // Update HCP display (bidding phase only)
            var hcpSpan = labelEl.querySelector('.bp-hcp');
            if (visible && G.hands[i] && G.hands[i].cards.length > 0) {
                G.hands[i].isPublic = true;
                renderHand(G.hands[i], els[dPos], canClick);
                var hcp = handHCP(G.hands[i]);
                if (G.phase === 'bidding' && !G.matchHideInfo) {
                    if (!hcpSpan) {
                        hcpSpan = document.createElement('span');
                        hcpSpan.className = 'bp-hcp';
                        labelEl.insertBefore(hcpSpan, labelEl.firstChild);
                    }
                    hcpSpan.textContent = hcp + ' HCP';
                    hcpSpan.style.display = '';
                } else {
                    if (hcpSpan) hcpSpan.style.display = 'none';
                }
            } else {
                var el = document.getElementById(els[dPos]);
                el.innerHTML = '';
                el.classList.add('bp-hidden');
                if (hcpSpan) hcpSpan.style.display = 'none';
            }
        }
    }

    function shouldShowHand(playerIdx) {
        if (!G.hands[playerIdx] || G.hands[playerIdx].cards.length === 0) return false;
        if (G.phase === 'ended') return true;
        if (G.multiplayer) {
            // In multiplayer: see own hand + dummy (after revealed)
            if (playerIdx === G.mySeat) return true;
            if (G.dummy >= 0 && playerIdx === G.dummy) return true;
            return false;
        }
        if (G.noHuman || G.visible) return true;
        if (G.humanSeats[playerIdx]) return true;
        if (G.dummy >= 0 && playerIdx === G.dummy) return true;
        // Declarer controls dummy: show declarer hand when it's dummy's turn
        if (G.dummy >= 0 && (playerIdx + 2) % 4 === G.dummy && G.humanSeats[playerIdx]) return true;
        return false;
    }

    function isPlayerTurn(playerIdx) {
        if (G.turn !== playerIdx && !(G.dummy >= 0 && G.turn === G.dummy && (playerIdx + 2) % 4 === G.dummy)) {
            return false;
        }
        if (G.multiplayer) {
            // In multiplayer: it's my turn if playerIdx is my seat
            if (playerIdx === G.mySeat) return true;
            // Or if it's dummy's turn and I'm the declarer
            if (G.dummy >= 0 && playerIdx === G.dummy) {
                var declarer = (G.dummy + 2) % 4;
                return declarer === G.mySeat;
            }
            return false;
        }
        if (G.humanSeats[playerIdx]) return true;
        if (G.dummy >= 0 && playerIdx === G.dummy) {
            var declarer = (G.dummy + 2) % 4;
            return G.humanSeats[declarer];
        }
        return false;
    }

    function renderTrick() {
        var slots = ['bp-trick-n', 'bp-trick-e', 'bp-trick-s', 'bp-trick-w'];
        for (var s = 0; s < 4; s++) {
            document.getElementById(slots[s]).innerHTML = '';
        }
        if (!G.currentTrick) return;
        for (var j = 0; j < G.currentTrick.cards.length; j++) {
            var pIdx = (G.currentTrick.leadPlayer + j) % 4;
            var card = G.currentTrick.cards[j];
            var el = document.getElementById(slots[displayPos(pIdx)]);
            var div = document.createElement('div');
            div.className = 'bp-played-card ' + PC_CLASSES[card.suit];
            div.textContent = card.rank + SUIT_SYMBOLS[card.suit];
            el.appendChild(div);
        }
    }

    function clearTrickSlots() {
        ['bp-trick-n', 'bp-trick-e', 'bp-trick-s', 'bp-trick-w'].forEach(function(id) {
            document.getElementById(id).innerHTML = '';
        });
    }

    function renderAuction() {
        var el = document.getElementById('bp-auction-table');
        var bids = [];
        for (var i = 0; i < G.auction.length; i++) {
            if (G.auction[i] !== 'PAD_START') bids.push(G.auction[i]);
        }
        var nPad = [1, 2, 3, 0][G.dealer];
        var padded = [];
        for (var p = 0; p < nPad; p++) padded.push('');
        for (var b = 0; b < bids.length; b++) padded.push(bids[b]);

        var html = '<table><thead><tr>';
        var headers = ['West', 'North', 'East', 'South'];
        var vulMap = [false, false, false, false];
        vulMap[0] = G.vuln[1]; vulMap[1] = G.vuln[0]; vulMap[2] = G.vuln[1]; vulMap[3] = G.vuln[0];
        for (var h = 0; h < 4; h++) {
            html += '<th' + (vulMap[h] ? ' class="bp-vul-header"' : '') + '>' + headers[h] + '</th>';
        }
        html += '</tr></thead><tbody>';
        for (var r = 0; r < padded.length; r++) {
            if (r % 4 === 0) html += '<tr>';
            var bidIdx = r - nPad; // index into G.bidExplanations
            var dataAttr = '';
            if (bidIdx >= 0 && bidIdx < G.bidExplanations.length && G.bidExplanations[bidIdx]) {
                dataAttr = ' data-explain="' + G.bidExplanations[bidIdx].replace(/"/g, '&quot;') + '"';
            }
            html += '<td' + dataAttr + '>' + formatBid(padded[r]) + '</td>';
            if (r % 4 === 3) html += '</tr>';
        }
        if (padded.length % 4 !== 0) html += '</tr>';
        html += '</tbody></table>';
        el.innerHTML = html;

        // Attach hover events for custom tooltips
        el.querySelectorAll('td[data-explain]').forEach(function(td) {
            td.addEventListener('mouseenter', function() {
                showBidTip(td, formatExplanation(td.getAttribute('data-explain')));
            });
            td.addEventListener('mouseleave', hideBidTip);
        });
    }

    function renderBiddingBox() {
        var box = document.getElementById('bp-bidding-box');
        if (!G.expectBidInput) { hide(box); return; }
        show(box);

        var levelsEl = document.getElementById('bp-bb-levels');
        levelsEl.innerHTML = '';
        var cleanBids = [];
        for (var i = 0; i < G.auction.length; i++) {
            if (G.auction[i] !== 'PAD_START') cleanBids.push(G.auction[i]);
        }
        var minLevel = getMinBiddableLevel(cleanBids);
        for (var lv = 1; lv <= 7; lv++) {
            var btn = document.createElement('div');
            btn.className = 'bp-bb-level';
            btn.textContent = lv;
            btn.setAttribute('data-level', lv);
            if (lv < minLevel) btn.classList.add('bp-bb-invalid');
            btn.addEventListener('click', onBidLevelClick);
            levelsEl.appendChild(btn);
        }

        var suitsEl = document.getElementById('bp-bb-suits');
        suitsEl.innerHTML = '';
        hide(suitsEl);
        var suitSymbols = ['\u2663', '\u2666', '\u2665', '\u2660', 'NT'];
        var suitLetters = ['C', 'D', 'H', 'S', 'N'];
        var suitColorClasses = ['bp-suit-c', 'bp-suit-d', 'bp-suit-h', 'bp-suit-s', ''];
        for (var si = 0; si < 5; si++) {
            var sb = document.createElement('div');
            sb.className = 'bp-bb-suit';
            if (suitColorClasses[si]) sb.classList.add(suitColorClasses[si]);
            sb.textContent = suitSymbols[si];
            sb.setAttribute('data-suit', suitLetters[si]);
            sb.addEventListener('click', onBidSuitClick);
            suitsEl.appendChild(sb);
        }

        var passBtn = box.querySelector('.bp-bb-pass');
        var dblBtn = box.querySelector('.bp-bb-dbl');
        var rdblBtn = box.querySelector('.bp-bb-rdbl');
        var hintBtn = box.querySelector('.bp-bb-hint');

        dblBtn.disabled = !G.canDouble;
        rdblBtn.disabled = !G.canRedouble;

        // Add custom tooltips for Pass/X/XX from bid previews
        function attachBidTip(el, bidKey) {
            el.addEventListener('mouseenter', function() {
                var expl = G.bidPreviews[bidKey];
                if (expl) showBidTip(el, formatExplanation(expl));
            });
            el.addEventListener('mouseleave', hideBidTip);
        }
        attachBidTip(passBtn, 'PASS');
        attachBidTip(dblBtn, 'X');
        attachBidTip(rdblBtn, 'XX');

        passBtn.onclick = function() { if (G.expectBidInput) { G.ws.send('PASS'); G.expectBidInput = false; } };
        dblBtn.onclick = function() { if (G.expectBidInput && G.canDouble) { G.ws.send('X'); G.expectBidInput = false; } };
        rdblBtn.onclick = function() { if (G.expectBidInput && G.canRedouble) { G.ws.send('XX'); G.expectBidInput = false; } };
        hintBtn.onclick = function() {
            if (G.expectBidInput) {
                G.ws.send('Hint');
                G.expectBidInput = false;
                show('#bp-loader');
            }
        };

        G.selectedLevel = null;
        setStatus('Your bid');
    }

    function renderTricks() {
        var ns = G.tricksCount[0];
        var ew = G.tricksCount[1];
        document.getElementById('bp-tricks-display').innerHTML =
            'NS: ' + ns + ' &nbsp; EW: ' + ew;

        // Update progress bar
        var total = ns + ew;
        var bar = document.getElementById('bp-tricks-bar');
        if (total > 0) {
            show(bar);
            document.getElementById('bp-tricks-ns-bar').style.width = (ns / 13 * 100) + '%';
            document.getElementById('bp-tricks-ew-bar').style.width = (ew / 13 * 100) + '%';
        } else {
            hide(bar);
        }
    }

    function renderContract() {
        if (G.declarer < 0) { hide('#bp-contract-panel'); return; }
        show('#bp-contract-panel');
        var lastBid = '';
        var doubled = false, redoubled = false;
        for (var i = G.auction.length - 1; i >= 0; i--) {
            var b = G.auction[i];
            if (b === 'PAD_START' || b === 'Pass' || b === 'PASS') continue;
            if (b === 'XX') { redoubled = true; continue; }
            if (b === 'X') { doubled = true; continue; }
            lastBid = b;
            break;
        }
        var html = formatBid(lastBid);
        if (redoubled) html += ' XX';
        else if (doubled) html += ' X';
        html += ' by ' + SEAT_LABELS[G.declarer];
        document.getElementById('bp-contract-display').innerHTML = html;
    }

    function setTurnIndicator() {
        var labels = ['bp-label-n', 'bp-label-e', 'bp-label-s', 'bp-label-w'];
        for (var i = 0; i < 4; i++) {
            var el = document.getElementById(labels[displayPos(i)]);
            el.classList.remove('bp-turn');
            if (i === G.turn) el.classList.add('bp-turn');
        }
    }

    function setDealerVulIndicators() {
        var labels = ['bp-label-n', 'bp-label-e', 'bp-label-s', 'bp-label-w'];
        for (var i = 0; i < 4; i++) {
            var dPos = displayPos(i);
            var el = document.getElementById(labels[dPos]);
            el.classList.remove('bp-dealer', 'bp-vul');
            el.textContent = SEAT_LABELS[i];
            if (i === G.dealer) el.classList.add('bp-dealer');
            if ((i % 2 === 0 && G.vuln[0]) || (i % 2 === 1 && G.vuln[1])) {
                el.classList.add('bp-vul');
            }
            // In multiplayer, mark the player's own seat
            if (G.multiplayer && i === G.mySeat) {
                el.textContent = SEAT_LABELS[i] + ' (you)';
            }
        }
    }

    function addExplanation(bidStr, explanation) {
        if (G.matchHideInfo) return;
        var el = document.getElementById('bp-explain');
        var div = document.createElement('div');
        div.className = 'bp-explain-entry';
        div.innerHTML = '<span class="bp-explain-bid">' + formatBid(bidStr) + '</span> = ' +
            '<span class="bp-explain-text">' + (explanation || '') + '</span>';
        el.appendChild(div);
        el.scrollTop = el.scrollHeight;
    }

    // === HCP / Suit Inference ===

    var SEAT_CHARS = ['N', 'E', 'S', 'W'];
    var HCP_VALUES = { 'A': 4, 'K': 3, 'Q': 2, 'J': 1 };

    function handToPBN(hand) {
        var pbn = [];
        for (var si = 0; si < 4; si++) {
            var ranks = '';
            for (var ci = 0; ci < hand.suits[si].length; ci++) {
                ranks += hand.suits[si][ci].rank;
            }
            pbn.push(ranks);
        }
        return pbn.join('.');
    }

    function handHCP(hand) {
        var hcp = 0;
        for (var i = 0; i < hand.cards.length; i++) {
            hcp += (HCP_VALUES[hand.cards[i].rank] || 0);
        }
        return hcp;
    }

    function getHumanSeat() {
        for (var i = 0; i < 4; i++) {
            if (G.humanSeats[i]) return i;
        }
        return -1;
    }

    function fetchInference() {
        if (G.matchHideInfo) return;
        var seat = getHumanSeat();
        if (seat < 0 || !G.hands[seat] || G.hands[seat].cards.length === 0) return;

        var pbn = handToPBN(G.hands[seat]);
        var seatChar = SEAT_CHARS[seat];
        var dealerChar = SEAT_CHARS[G.dealer];

        // Vulnerability format for API
        var vulStr = '';
        if (G.vuln[0] && G.vuln[1]) vulStr = 'BOTH';
        else if (G.vuln[0]) vulStr = 'NS';
        else if (G.vuln[1]) vulStr = 'EW';

        // Auction context: clean bids joined by -
        var cleanBids = [];
        for (var i = 0; i < G.auction.length; i++) {
            if (G.auction[i] !== 'PAD_START') {
                var b = G.auction[i];
                if (b === 'Pass' || b === 'PASS') b = 'P';
                cleanBids.push(b);
            }
        }
        var ctx = cleanBids.join('-');

        var apiBase = buildApiBase();
        var url = apiBase + '/bid?hand=' + encodeURIComponent(pbn) +
            '&seat=' + seatChar +
            '&dealer=' + dealerChar +
            '&vul=' + vulStr +
            '&ctx=' + encodeURIComponent(ctx) +
            '&details=true';

        fetch(url).then(function(r) {
            if (!r.ok) throw new Error('API error');
            return r.json();
        }).then(function(data) {
            if (G.phase === 'bidding') {
                renderInference(data, seat);
            }
        }).catch(function(e) {
            console.error('Inference fetch error:', e);
        });
    }

    function renderInference(data, humanSeat) {
        var panel = document.getElementById('bp-inference-panel');
        var content = document.getElementById('bp-inference-content');

        if (!data || !data.hcp || data.hcp[0] === -1) {
            // In bidding practice, keep showing previous inference data
            if (G.mode !== 'bidding') hide(panel);
            return;
        }

        // Map relative positions to absolute seats
        // hcp/shape arrays: [LHO, Partner, RHO]
        var lho = (humanSeat + 1) % 4;
        var partner = (humanSeat + 2) % 4;
        var rho = (humanSeat + 3) % 4;

        var suitSyms = ['\u2660', '\u2665', '\u2666', '\u2663'];
        var suitCls = ['bp-suit-s', 'bp-suit-h', 'bp-suit-d', 'bp-suit-c'];

        var players = [
            { name: SEAT_LABELS[lho], hcp: data.hcp[0], shapeIdx: 0 },
            { name: SEAT_LABELS[partner], hcp: data.hcp[1], shapeIdx: 1 },
            { name: SEAT_LABELS[rho], hcp: data.hcp[2], shapeIdx: 2 }
        ];

        var html = '<div class="bp-dd-table"><table>';
        html += '<thead><tr><th></th><th>HCP</th>';
        for (var si = 0; si < 4; si++) {
            html += '<th><span class="' + suitCls[si] + '">' + suitSyms[si] + '</span></th>';
        }
        html += '</tr></thead><tbody>';

        for (var p = 0; p < players.length; p++) {
            var pl = players[p];
            html += '<tr><td class="bp-dd-strain">' + pl.name + '</td>';
            html += '<td style="font-weight:700">' + (typeof pl.hcp === 'number' ? pl.hcp.toFixed(1) : pl.hcp) + '</td>';
            if (data.shape && data.shape.length >= 12) {
                for (var si = 0; si < 4; si++) {
                    var val = data.shape[pl.shapeIdx * 4 + si];
                    html += '<td>' + (typeof val === 'number' ? val.toFixed(1) : val) + '</td>';
                }
            }
            html += '</tr>';
        }

        // Add human's actual hand
        if (G.hands[humanSeat] && G.hands[humanSeat].cards.length > 0) {
            var myHCP = handHCP(G.hands[humanSeat]);
            html += '<tr style="border-top:2px solid #ddd"><td class="bp-dd-strain">' + SEAT_LABELS[humanSeat] + '</td>';
            html += '<td style="font-weight:700">' + myHCP + '</td>';
            for (var si = 0; si < 4; si++) {
                html += '<td>' + G.hands[humanSeat].suits[si].length + '</td>';
            }
            html += '</tr>';
        }

        html += '</tbody></table></div>';

        // Combined HCP with partner
        var myHCP = handHCP(G.hands[humanSeat]);
        var partnerHCP = data.hcp[1];
        if (typeof partnerHCP === 'number') {
            var combined = myHCP + partnerHCP;
            var zone = 'Partscore';
            var zoneClass = 'bp-zone-partscore';
            if (combined >= 33) { zone = 'Grand Slam'; zoneClass = 'bp-zone-grand'; }
            else if (combined >= 30) { zone = 'Slam'; zoneClass = 'bp-zone-slam'; }
            else if (combined >= 25) { zone = 'Game'; zoneClass = 'bp-zone-game'; }

            html += '<div class="bp-inf-combined">';
            html += '<span class="bp-inf-combined-pts">' + myHCP + ' + ' + partnerHCP.toFixed(1) + ' = ' + combined.toFixed(1) + '</span>';
            html += ' <span class="bp-zone-badge ' + zoneClass + '">' + zone + '</span>';
            html += '</div>';

            // Check for 8+ card fits
            if (data.shape && data.shape.length >= 12) {
                var fits = [];
                for (var fi = 0; fi < 4; fi++) {
                    var myLen = G.hands[humanSeat].suits[fi].length;
                    var partnerLen = data.shape[1 * 4 + fi];
                    var totalFit = myLen + partnerLen;
                    if (totalFit >= 8) {
                        fits.push(suitSyms[fi] + ' ' + myLen + '+' + partnerLen.toFixed(1) + '=' + totalFit.toFixed(1));
                    }
                }
                if (fits.length > 0) {
                    html += '<div class="bp-inf-fit">Fit: <span class="bp-inf-fit-good">' + fits.join(', ') + '</span></div>';
                }
            }
        }

        content.innerHTML = html;
        show(panel);
    }

    function renderInferenceFromHint(data, humanSeat) {
        // Hint data has the same hcp/shape structure inside data.bids
        if (data.bids) {
            renderInference(data.bids, humanSeat);
        }
    }

    function resetHintPanel() {
        document.getElementById('bp-hint-panel').innerHTML =
            '<span class="bp-hint-placeholder">Click "Hint" during bidding to get BEN\'s suggestion</span>';
    }

    function showHintPanel(data) {
        var panel = document.getElementById('bp-hint-panel');
        var html = '<button class="bp-hint-close" id="bp-hint-close-btn">&times;</button>';
        html += '<div class="bp-hint-title">BEN suggests</div>';
        html += '<div class="bp-hint-bid">' + formatBid(data.bids.bid) + '</div>';
        if (data.bids.explanation) {
            html += '<div class="bp-hint-explanation">' + data.bids.explanation + '</div>';
        }
        if (data.bids.candidates && data.bids.candidates.length > 0) {
            html += '<div class="bp-hint-candidates">';
            html += '<table><thead><tr><th>Bid</th><th>Score</th></tr></thead><tbody>';
            for (var c = 0; c < data.bids.candidates.length; c++) {
                var cand = data.bids.candidates[c];
                html += '<tr><td>' + formatBid(cand.call) + '</td>';
                html += '<td>' + (cand.insta_score !== undefined ? cand.insta_score : '') + '</td></tr>';
            }
            html += '</tbody></table></div>';
        }
        panel.innerHTML = html;
        show(panel);
        document.getElementById('bp-hint-close-btn').addEventListener('click', function() {
            resetHintPanel();
        });
    }

    // === Event Handlers ===

    function onCardClick(e) {
        if (!G.expectCardInput) return;
        var sym = e.target.getAttribute('data-symbol');
        if (!sym) return;
        var card = new Card(sym);

        var playHand = G.hands[G.turn];
        if (G.dummy >= 0 && G.turn === G.dummy) {
            playHand = G.hands[G.dummy];
        }
        if (playHand && playHand.isPlayable(card, G.currentTrick)) {
            G.ws.send(card.symbol);
            G.expectCardInput = false;
            _lastCardTime = 0; // next AI card shows without delay
            setStatus('');
        }
    }

    function onBidLevelClick(e) {
        if (!G.expectBidInput) return;
        if (e.target.classList.contains('bp-bb-invalid')) return;

        document.querySelectorAll('.bp-bb-level').forEach(function(el) { el.classList.remove('bp-bb-selected'); });
        e.target.classList.add('bp-bb-selected');
        G.selectedLevel = parseInt(e.target.getAttribute('data-level'));

        var suitsEl = document.getElementById('bp-bb-suits');
        show(suitsEl);

        var cleanBids = [];
        for (var i = 0; i < G.auction.length; i++) {
            if (G.auction[i] !== 'PAD_START') cleanBids.push(G.auction[i]);
        }
        var minSuit = getMinBiddableSuit(cleanBids, G.selectedLevel);
        var suitLetters = ['C', 'D', 'H', 'S', 'N'];
        var suitBtns = suitsEl.querySelectorAll('.bp-bb-suit');
        suitBtns.forEach(function(btn, idx) {
            btn.classList.remove('bp-bb-invalid');
            if (idx < minSuit) btn.classList.add('bp-bb-invalid');
            var bidKey = G.selectedLevel + suitLetters[idx];
            // Remove old listeners by cloning
            var newBtn = btn.cloneNode(true);
            newBtn.addEventListener('click', onBidSuitClick);
            (function(key) {
                newBtn.addEventListener('mouseenter', function() {
                    var expl = G.bidPreviews[key];
                    if (expl) showBidTip(newBtn, formatExplanation(expl));
                });
                newBtn.addEventListener('mouseleave', hideBidTip);
            })(bidKey);
            btn.parentNode.replaceChild(newBtn, btn);
        });
    }

    function onBidSuitClick(e) {
        if (!G.expectBidInput) return;
        if (e.target.classList.contains('bp-bb-invalid')) return;
        if (!G.selectedLevel) return;

        var suit = e.target.getAttribute('data-suit');
        var bid = G.selectedLevel + suit;
        G.ws.send(bid);
        G.expectBidInput = false;
        setStatus('');
    }

    // === WebSocket Message Handler ===

    // Queue play-phase messages to enforce minimum delay between card plays
    var _playQueue = [];
    var _lastCardTime = 0;
    var _playQueueTimer = null;
    var _trickPaused = false; // pause queue while completed trick is displayed
    var _CARD_DELAY = 2000; // ms between consecutive card plays

    function handleMessage(event) {
        var data;
        try { data = JSON.parse(event.data); } catch (e) { return; }

        // During play phase, queue card_played / trick_confirm / show_dummy / deal_end
        var dominated = G.phase === 'play' &&
            (data.message === 'card_played' || data.message === 'trick_confirm' ||
             data.message === 'show_dummy' || data.message === 'deal_end');
        if (dominated) {
            _playQueue.push(data);
            _drainPlayQueue();
            return;
        }
        _processMessage(data);
    }

    function _drainPlayQueue() {
        if (_playQueueTimer) return; // already scheduled
        if (_playQueue.length === 0) return;
        if (_trickPaused) return; // paused while completed trick is visible
        var next = _playQueue[0];
        // Only delay card_played messages; show_dummy/trick_confirm/deal_end process immediately
        var wait = 0;
        if (next.message === 'card_played' && _lastCardTime !== 0) {
            wait = Math.max(0, _CARD_DELAY - (Date.now() - _lastCardTime));
        }
        _playQueueTimer = setTimeout(function() {
            _playQueueTimer = null;
            if (_playQueue.length === 0) return;
            var msg = _playQueue.shift();
            if (msg.message === 'card_played') _lastCardTime = Date.now();
            _processMessage(msg);
            _drainPlayQueue();
        }, wait);
    }

    function _processMessage(data) {
        hide('#bp-loader');

        // Multiplayer coordination messages
        if (data.message === 'mp_connected') {
            setStatus('Connected as ' + SEAT_LABELS['NESW'.indexOf(data.seat)] +
                '. Waiting for players: ' + data.connected.join(', '));
            return;
        }
        if (data.message === 'mp_player_joined') {
            setStatus('Player joined (' + data.seat + '). Connected: ' + data.connected.join(', '));
            return;
        }
        if (data.message === 'waiting_for') {
            // Another player's turn — just update status
            setStatus('Waiting for ' + SEAT_LABELS[data.seat] + '...');
            return;
        }

        // === Session messages (multi-board) ===
        if (data.message === 'session_start') {
            G.sessionMode = data.mode;
            G.sessionTotalBoards = data.num_rounds || 0;
            G.sessionBoardIdx = 0;
            G.sessionResults = [];
            G.cumulativeScoreNS = 0;
            G.cumulativeScoreEW = 0;
            G.cumulativeIMPs = 0;
            G.sessionEnded = false;
            updateSessionBar();
            show('#bp-session-bar');
            return;
        }
        if (data.message === 'board_transition') {
            G.sessionBoardIdx = data.board_idx + 1;
            if (data.cumulative_ns !== undefined) G.cumulativeScoreNS = data.cumulative_ns;
            if (data.cumulative_ew !== undefined) G.cumulativeScoreEW = data.cumulative_ew;
            if (data.cumulative_imps !== undefined) G.cumulativeIMPs = data.cumulative_imps;
            G.sessionResults.push({
                board_idx: data.board_idx, score_ns: data.score_ns,
                contract: data.contract, tricks: data.tricks, declarer: data.declarer
            });
            updateSessionBar();
            if (data.has_next) {
                var isMatch = G.sessionMode && G.sessionMode.indexOf('match') === 0;
                if (isMatch) {
                    setStatus('Board ' + (data.board_idx + 1) + ' complete. Next board starting...');
                    resetForNextBoard();
                } else {
                    // Show dual result in review and add "Next Board" button
                    showDualResultInReview();
                    showNextBoardButton();
                }
            }
            return;
        }
        if (data.message === 'dual_table_result') {
            G.lastDualResult = data;
            var dualEl = document.getElementById('bp-session-score');
            if (dualEl) {
                var sign = data.imp >= 0 ? '+' : '';
                dualEl.textContent = 'IMPs: ' + sign + data.cumulative_imps;
            }
            // If review is already visible, add dual result immediately
            showDualResultInReview();
            return;
        }
        if (data.message === 'session_end') {
            G.sessionEnded = true;
            showSessionEnd(data);
            return;
        }
        if (data.message === 'match_waiting') {
            setStatus('Waiting for other table to finish...');
            return;
        }

        if (data.message === 'deal_start') {
            // Reset play queue for new deal
            _playQueue = [];
            _lastCardTime = 0;
            _trickPaused = false;
            if (_playQueueTimer) { clearTimeout(_playQueueTimer); _playQueueTimer = null; }
            hide('#bp-board-transition');

            G.phase = 'bidding';
            G.dealer = data.dealer;
            G.vuln = data.vuln;
            G.boardNo = data.board_no || '';
            G.auction = [];
            G.tricks = [];
            G.currentTrick = null;
            G.tricksCount = [0, 0];
            G.declarer = -1;
            G.dummy = -1;
            G.strain = -1;
            G.lastTrick = null;
            G.expectBidInput = false;
            G.expectCardInput = false;
            G.expectTrickConfirm = false;
            G.bidExplanations = [];
            G.bidPreviews = {};
            G.turn = data.dealer;

            // Multiplayer: update seat from server
            if (data.multiplayer && data.your_seat !== undefined) {
                G.mySeat = data.your_seat;
            }

            for (var i = 0; i < 4; i++) {
                G.hands[i] = new Hand([], false);
                if (data.hand[i]) {
                    G.hands[i].setCards(parseHand(data.hand[i]));
                }
                if (G.multiplayer) {
                    if (i === G.mySeat) G.hands[i].isPublic = true;
                } else {
                    if (G.humanSeats[i]) G.hands[i].isPublic = true;
                }
            }

            document.getElementById('bp-board-display').textContent = 'Board ' + G.boardNo;
            document.getElementById('bp-explain').innerHTML = '';
            hide('#bp-review');
            hide('#bp-contract-panel');
            hide('#bp-last-trick');
            hide('#bp-claim-btn');
            hide('#bp-concede-btn');
            hide('#bp-replay');
            hide('#bp-back-to-review');
            resetHintPanel();
            hide('#bp-tricks-bar');

            // Show inference panel (will populate after first bid)
            show('#bp-inference-panel');
            document.getElementById('bp-inference-content').innerHTML =
                '<span style="color:#aaa;font-style:italic;font-size:0.8rem">Inference will update as bidding progresses</span>';

            setDealerVulIndicators();
            setTurnIndicator();
            renderAllHands();
            renderAuction();
            renderTricks();
            setStatus('Bidding');

        } else if (data.message === 'get_bid_input') {
            G.auction = data.auction;
            G.canDouble = data.can_double;
            G.canRedouble = data.can_redouble;
            G.bidPreviews = data.bid_previews || {};
            G.expectBidInput = true;
            renderAuction();
            renderBiddingBox();
            fetchInference();

        } else if (data.message === 'bid_made') {
            G.auction = data.auction;
            var lastBid = data.auction[data.auction.length - 1];
            G.bidExplanations.push(G.matchHideInfo ? '' : (data.explanation || ''));
            addExplanation(lastBid, data.explanation);
            G.turn = (G.turn + 1) % 4;
            setTurnIndicator();
            renderAuction();
            renderAllHands();
            setStatus(SEAT_LABELS[G.turn] + ' to bid');
            fetchInference();

        } else if (data.message === 'hint') {
            showHintPanel(data);
            renderInferenceFromHint(data, getHumanSeat());
            G.expectBidInput = true;

        } else if (data.message === 'alert') {
            if (data.alert === 'True') {
                setStatus('Your bid will be alerted');
            } else {
                setStatus('Your bid will NOT be alerted');
            }

        } else if (data.message === 'auction_end') {
            G.phase = 'play';
            G.auction = data.auction;
            G.declarer = data.declarer;
            G.strain = data.strain;
            G.turn = (data.declarer + 1) % 4;
            G.currentTrick = new Trick(G.turn, []);
            G.expectBidInput = false;

            // Playing practice: South becomes human for play phase
            if (G.mode === 'playing') {
                G.humanSeats = [false, false, true, false];
                G.noHuman = false;
                G.hands[2].isPublic = true;
                renderAllHands();
            }

            hide('#bp-bidding-box');
            resetHintPanel();
            setTurnIndicator();
            renderAuction();
            renderContract();
            renderAllHands();
            show('#bp-loader');
            setStatus('Waiting for opening lead...');

        } else if (data.message === 'show_dummy') {
            G.dummy = (G.declarer + 2) % 4;
            G.hands[data.player].setCards(parseHand(data.dummy));
            G.hands[data.player].isPublic = true;
            renderAllHands();

        } else if (data.message === 'card_played') {
            var card = new Card(data.card);
            G.currentTrick.cards.push(card);
            hide('#bp-last-trick');
            hide('#bp-claim-btn');
            hide('#bp-concede-btn');

            updateHandAfterPlay(data.player, card);

            renderTrick();
            G.turn = (data.player + 1) % 4;
            setTurnIndicator();
            renderAllHands();
            // Only show loader if still waiting for server (not if human input already requested)
            if (!G.expectCardInput) {
                show('#bp-loader');
            }
            setStatus(SEAT_LABELS[G.turn] + ' to play');

        } else if (data.message === 'get_card_input') {
            hide('#bp-loader');

            // 复盘 auto-play: feed original cards until target reached
            if (G.replayCards && G.replayIdx < G.replayCards.length) {
                var autoCard = G.replayCards[G.replayIdx++];
                G.ws.send(autoCard);
                return;
            }
            // Reached target position — switch to normal play
            if (G.replayCards) {
                G.replayCards = null;
                G.replayMode = true;
                show('#bp-back-to-review');
                setStatus('Your play (exploring)');
            }

            G.expectCardInput = true;

            if (G.currentTrick.cards.length === 0 && G.tricks.length > 0) {
                show('#bp-claim-btn');
            } else {
                show('#bp-concede-btn');
            }

            renderAllHands();
            if (!G.replayMode) setStatus('Your play');

        } else if (data.message === 'claim_rejected') {
            setStatus('Claim rejected');
            G.expectCardInput = true;
            renderAllHands();

        } else if (data.message === 'trick_confirm') {
            var winner = G.currentTrick.winner(G.strain);
            G.turn = winner;
            setTurnIndicator();

            G.lastTrick = G.currentTrick;
            G.tricks.push(G.currentTrick);
            G.currentTrick = new Trick(winner, []);

            G.tricksCount[winner % 2] += 1;
            renderTricks();

            if (G.multiplayer) {
                // Pause queue so completed trick stays visible, resume after clear
                _trickPaused = true;
                setStatus(SEAT_LABELS[winner] + ' wins trick ' + G.tricks.length);
                G.autoTimeoutId = setTimeout(function() {
                    clearTrickSlots();
                    show('#bp-last-trick');
                    _trickPaused = false;
                    _lastCardTime = 0;
                    _drainPlayQueue(); // resume processing queued cards
                }, 2000);
                // Send immediate confirm to server
                G.ws.send('y');
                return;
            }

            G.expectTrickConfirm = true;

            // During 复盘 fast-forward, confirm tricks instantly
            if (G.replayCards && G.replayIdx < G.replayCards.length) {
                sendConfirmTrick();
                return;
            }

            setStatus(SEAT_LABELS[winner] + ' wins trick ' + G.tricks.length);

            G.autoTimeoutId = setTimeout(function() {
                sendConfirmTrick();
            }, 2000);

        } else if (data.message === 'deal_end') {
            G.phase = 'ended';
            G.lastPbn = data.pbn;
            if (!G.multiplayer) {
                show('#bp-replay');
                if (G.mode !== 'playing') show('#bp-restart-bidding');
            }
            setTurnIndicator();

            var pbnHands = data.pbn.split(' ');
            for (var h = 0; h < 4; h++) {
                G.hands[h].setCards(parseHand(pbnHands[h]));
                G.hands[h].isPublic = true;
            }
            renderAllHands();

            if (data.dict && data.dict.claimed) {
                var tw = G.turn % 2;
                G.tricksCount[tw] += data.dict.claimed;
                G.tricksCount[(tw + 1) % 2] = 13 - G.tricksCount[tw];
                renderTricks();
                setStatus('Claim accepted');
            } else {
                setStatus('Game over');
            }

            hide('#bp-last-trick');
            hide('#bp-claim-btn');
            hide('#bp-concede-btn');
            clearTrickSlots();

            if (G.replayMode) {
                // 复盘 exploration ended — show result and allow returning to review
                G.replayMode = false;
                var expResult = 'NS ' + G.tricksCount[0] + ' - EW ' + G.tricksCount[1];
                setStatus('Exploration done: ' + expResult);
                show('#bp-back-to-review');
                return;
            }

            // Multi-board session
            if (G.sessionMode) {
                var isMatch = G.sessionMode.indexOf('match') === 0;
                if (isMatch) {
                    // Match mode: no per-board review at all
                    setStatus('Board complete. Waiting...');
                    return;
                }
                // Casual/dual: show full review + "Next Board" button
                showReview(data.dict);
                return;
            }

            if (G.mode === 'bidding' || G.multiplayer) {
                showReview(data.dict);
            } else {
                showFeedbackDialog(data.dict);
            }

        } else if (data.message === 'ai_contract_update') {
            // Async update: BEN's contract arrived after review was already shown
            if (G.reviewDict) {
                G.reviewDict.ai_contract = data.ai_contract;
                renderReviewSummary(G.reviewDict);
            }
        }
    }

    function updateHandAfterPlay(player, card) {
        if (G.noHuman) {
            G.hands[player] = G.hands[player].play(card);
        } else {
            if (player === G.dummy) {
                G.hands[player] = G.hands[player].play(card);
            } else if (G.hands[player] && G.hands[player].hasCard(card)) {
                G.hands[player] = G.hands[player].play(card);
            }
        }
    }

    function sendConfirmTrick() {
        if (G.expectTrickConfirm) {
            G.expectTrickConfirm = false;
            clearTrickSlots();
            show('#bp-last-trick');
            G.ws.send('y');
            if (G.autoTimeoutId) clearTimeout(G.autoTimeoutId);
            show('#bp-loader');
        }
    }

    function showFeedbackDialog(dict) {
        var dialog = document.getElementById('bp-feedback-dialog');
        show(dialog);

        var resultEl = document.getElementById('bp-result-display');
        var resultHtml = '';
        if (dict) {
            if (dict.contract) {
                resultHtml += '<div><span class="bp-result-label">Contract: </span><span class="bp-result-value">' + dict.contract + '</span></div>';
            }
            resultHtml += '<div><span class="bp-result-label">Tricks: </span><span class="bp-result-value">NS ' + G.tricksCount[0] + ' - EW ' + G.tricksCount[1] + '</span></div>';
            if (dict.score !== undefined) {
                var scoreClass = dict.score >= 0 ? 'bp-score-plus' : 'bp-score-minus';
                var scorePrefix = dict.score >= 0 ? '+' : '';
                resultHtml += '<div><span class="bp-result-label">Score: </span><span class="bp-result-score ' + scoreClass + '">' + scorePrefix + dict.score + '</span></div>';
            }
        }
        if (!resultHtml) resultHtml = 'NS: ' + G.tricksCount[0] + ' &nbsp; EW: ' + G.tricksCount[1];
        resultEl.innerHTML = resultHtml;

        document.getElementById('bp-feedback-text').value = '';

        dialog.querySelectorAll('.bp-fb-btn').forEach(function(btn) {
            btn.onclick = function() {
                var quality = btn.getAttribute('data-quality');
                if (quality !== 'skip') {
                    var feedback = document.getElementById('bp-feedback-text').value;
                    saveDeal(dict, feedback, quality);
                }
                hide(dialog);
                showReview(dict);
            };
        });
    }

    function saveDeal(dict, feedback, quality) {
        if (!dict) return;
        dict.feedback = feedback;
        dict.quality = quality;
        fetch('/api/save/deal', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(dict)
        }).then(function(r) {
            if (!r.ok) console.error('Failed to save deal');
        }).catch(function(e) {
            console.error('Error saving deal:', e);
        });
    }

    // === Post-Game Review ===

    function fetchHumanCardAnalysis(dict, onComplete) {
        var play = dict.play || [];
        if (play.length === 0 || dict.declarer === undefined) { onComplete(); return; }

        var hands = (dict.hands || '').split(' '); // N E S W PBN
        var dummyIdx = (dict.declarer + 2) % 4;
        var dummyHand = hands[dummyIdx];
        var seatChars = ['N', 'E', 'S', 'W'];

        // Build auction ctx
        var bids = dict.bids || [];
        var ctxParts = [];
        for (var bi = 0; bi < bids.length; bi++) {
            var bid = bids[bi].bid;
            if (!bid || bid === 'PAD_START') continue;
            if (bid === 'Pass' || bid === 'PASS') bid = 'P';
            ctxParts.push(bid);
        }
        var ctx = ctxParts.join('-');

        // Vulnerability
        var vulStr = '';
        if (dict.vuln_ns && dict.vuln_ew) vulStr = 'BOTH';
        else if (dict.vuln_ns) vulStr = 'NS';
        else if (dict.vuln_ew) vulStr = 'EW';

        var dealerChar = seatChars[dict.dealer];
        var firstLeader = (dict.declarer + 1) % 4;

        // Identify human cards needing analysis
        var tasks = [];
        var currentLeader = firstLeader;
        for (var ci = 0; ci < play.length; ci++) {
            var trickNum = Math.floor(ci / 4);
            var trickPos = ci % 4;
            if (trickPos === 0 && trickNum > 0 && dict.trick_winners) {
                // trick_winners are RELATIVE; convert to ABSOLUTE
                currentLeader = (dict.declarer + 1 + dict.trick_winners[trickNum - 1]) % 4;
            }
            var playerIdx = (currentLeader + trickPos) % 4;
            var cr = play[ci];

            // Skip cards that already have analysis
            if (cr.candidates && cr.candidates.length > 0) continue;

            // Build played string (all cards before this one)
            var playedStr = '';
            for (var pi = 0; pi < ci; pi++) {
                playedStr += play[pi].card;
            }

            // Can't call API as dummy - call as declarer instead
            var callSeat = playerIdx;
            if (playerIdx === dummyIdx) {
                callSeat = dict.declarer;
            }

            tasks.push({
                cardIdx: ci,
                hand: hands[callSeat],
                seat: seatChars[callSeat],
                played: playedStr
            });
        }

        if (tasks.length === 0) { onComplete(); return; }

        var statusEl = document.getElementById('bp-review-analysis-status');
        if (statusEl) {
            statusEl.textContent = 'Analyzing ' + tasks.length + ' human plays...';
            show(statusEl);
        }

        // Run sequentially - server has a mutex lock so parallel gives no benefit
        var apiBase = buildApiBase();
        var completed = 0;

        function runNext(idx) {
            if (idx >= tasks.length) {
                if (statusEl) hide(statusEl);
                onComplete();
                return;
            }
            var task = tasks[idx];
            var url = apiBase + '/play?hand=' + encodeURIComponent(task.hand) +
                '&dummy=' + encodeURIComponent(dummyHand) +
                '&played=' + encodeURIComponent(task.played) +
                '&seat=' + task.seat +
                '&vul=' + vulStr +
                '&dealer=' + dealerChar +
                '&ctx=' + encodeURIComponent(ctx) +
                '&details=true';

            fetch(url).then(function(r) {
                if (!r.ok) throw new Error('API error ' + r.status);
                return r.json();
            }).then(function(data) {
                if (data.candidates) {
                    play[task.cardIdx].candidates = data.candidates;
                }
                completed++;
                if (statusEl) {
                    statusEl.textContent = 'Analyzed ' + completed + ' of ' + tasks.length + ' plays...';
                }
                // Re-render current trick to show progress
                renderPlayReview(dict, G.reviewTrickIdx);
            }).catch(function(e) {
                console.error('Analysis error card ' + task.cardIdx + ':', e);
                completed++;
            }).then(function() {
                runNext(idx + 1);
            });
        }
        runNext(0);
    }

    function renderEquityGraph(dict) {
        var traj = dict.dd_trajectory;
        if (!traj || traj.length < 2) {
            hide('#bp-review-equity');
            return;
        }
        show('#bp-review-equity');

        var canvas = document.getElementById('bp-equity-canvas');
        var ctx = canvas.getContext('2d');
        var W = canvas.width, H = canvas.height;
        ctx.clearRect(0, 0, W, H);

        var nPoints = traj.length; // 0=before play, 1=after trick 1, ..., 13=after trick 13
        var level = dict.contract ? parseInt(dict.contract[0]) : 0;
        var needed = level + 6;
        var declSide = dict.declarer !== undefined ? dict.declarer % 2 : 0;

        // Layout
        var padL = 40, padR = 20, padT = 20, padB = 30;
        var gW = W - padL - padR;
        var gH = H - padT - padB;

        function xPos(i) { return padL + (i / (nPoints - 1)) * gW; }
        function yPos(v) { return padT + gH - (v / 13) * gH; }

        // Grid lines
        ctx.strokeStyle = '#e0e0e0';
        ctx.lineWidth = 0.5;
        for (var t = 0; t <= 13; t++) {
            var y = yPos(t);
            ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
        }
        for (var i = 0; i < nPoints; i++) {
            var x = xPos(i);
            ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + gH); ctx.stroke();
        }

        // Contract target line
        ctx.strokeStyle = '#888';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([6, 4]);
        var targetY = yPos(needed);
        ctx.beginPath(); ctx.moveTo(padL, targetY); ctx.lineTo(W - padR, targetY); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = '#888';
        ctx.font = '11px sans-serif';
        ctx.textAlign = 'right';
        ctx.fillText(needed + ' needed', W - padR - 2, targetY - 4);

        // Shading: green above target, red below
        for (var i = 0; i < nPoints - 1; i++) {
            var x1 = xPos(i), x2 = xPos(i + 1);
            var y1 = yPos(traj[i]), y2 = yPos(traj[i + 1]);
            // Determine if above or below target
            var above = (traj[i] >= needed && traj[i + 1] >= needed);
            var below = (traj[i] < needed && traj[i + 1] < needed);
            if (above) {
                ctx.fillStyle = 'rgba(76, 175, 80, 0.15)';
                ctx.beginPath();
                ctx.moveTo(x1, targetY); ctx.lineTo(x1, y1); ctx.lineTo(x2, y2); ctx.lineTo(x2, targetY);
                ctx.closePath(); ctx.fill();
            } else if (below) {
                ctx.fillStyle = 'rgba(244, 67, 54, 0.15)';
                ctx.beginPath();
                ctx.moveTo(x1, targetY); ctx.lineTo(x1, y1); ctx.lineTo(x2, y2); ctx.lineTo(x2, targetY);
                ctx.closePath(); ctx.fill();
            }
        }

        // Declarer DD line
        ctx.strokeStyle = '#1565c0';
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        for (var i = 0; i < nPoints; i++) {
            var x = xPos(i), y = yPos(traj[i]);
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();

        // Defense DD line (13 - declarer)
        ctx.strokeStyle = '#c62828';
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        for (var i = 0; i < nPoints; i++) {
            var x = xPos(i), y = yPos(13 - traj[i]);
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();
        ctx.setLineDash([]);

        // Data points
        for (var i = 0; i < nPoints; i++) {
            var x = xPos(i), y = yPos(traj[i]);
            ctx.fillStyle = traj[i] >= needed ? '#2e7d32' : '#c62828';
            ctx.beginPath(); ctx.arc(x, y, 3.5, 0, Math.PI * 2); ctx.fill();
        }

        // Y-axis labels
        ctx.fillStyle = '#555';
        ctx.font = '10px sans-serif';
        ctx.textAlign = 'right';
        for (var t = 0; t <= 13; t += 1) {
            if (t % 2 === 0 || t === needed) {
                ctx.fillText(t, padL - 4, yPos(t) + 3);
            }
        }

        // X-axis labels
        ctx.textAlign = 'center';
        for (var i = 0; i < nPoints; i++) {
            var label = i === 0 ? 'Start' : '' + i;
            if (nPoints > 10 && i > 0 && i < nPoints - 1 && i % 2 !== 0) continue;
            ctx.fillText(label, xPos(i), padT + gH + 16);
        }

        // Legend
        ctx.font = '11px sans-serif';
        ctx.textAlign = 'left';
        var legX = padL + 8, legY = padT + 14;
        ctx.fillStyle = '#1565c0';
        ctx.fillRect(legX, legY - 8, 14, 3);
        ctx.fillStyle = '#333';
        ctx.fillText('Declarer DD', legX + 18, legY - 3);
        ctx.fillStyle = '#c62828';
        ctx.setLineDash([4, 3]);
        ctx.strokeStyle = '#c62828'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(legX, legY + 8); ctx.lineTo(legX + 14, legY + 8); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = '#333';
        ctx.fillText('Defense DD', legX + 18, legY + 12);
    }

    function showReview(dict) {
        if (!dict) return;
        G.reviewDict = dict;
        G.reviewTrickIdx = 0;

        renderReviewSummary(dict);
        renderEquityGraph(dict);
        if (G.mode !== 'playing') {
            renderBiddingReview(dict);
        } else {
            hide('#bp-review-bidding');
        }
        renderPlayReview(dict, 0);
        renderKeyMoments(dict);

        show('#bp-review');

        // Scroll review into view
        document.getElementById('bp-review').scrollIntoView({ behavior: 'smooth' });

        // Human cards now include AI analysis from the game server (no retroactive fetch needed)
    }

    function showDualResultInReview() {
        if (!G.lastDualResult) return;
        var d = G.lastDualResult;
        // Remove existing dual panel if any
        var existing = document.getElementById('bp-dual-review');
        if (existing) existing.remove();

        var panel = document.createElement('div');
        panel.id = 'bp-dual-review';
        panel.style.cssText = 'margin:16px 0;padding:14px;background:#f0f7f4;border-radius:8px;border:1px solid #c5e0d0;';

        var aiContract = d.ai_contract ? d.ai_contract + (d.ai_declarer != null ? ' by ' + SEAT_LABELS[d.ai_declarer] : '') : 'Passed out';
        var aiTricks = d.ai_tricks || 0;
        var aiText = d.ai_score >= 0 ? '+' + d.ai_score : '' + d.ai_score;
        var impSign = d.imp >= 0 ? '+' : '';
        var impColor = d.imp >= 0 ? '#2a7' : '#c44';

        var html =
            '<div style="font-weight:700;font-size:1rem;margin-bottom:8px">AI Table Result</div>' +
            '<div style="display:flex;gap:24px;flex-wrap:wrap">' +
            '<div>Contract: <b>' + aiContract + '</b></div>' +
            '<div>Tricks: <b>' + aiTricks + '</b></div>' +
            '<div>Score: <b>' + aiText + '</b></div>' +
            '</div>' +
            '<div style="font-size:1.15rem;font-weight:700;margin-top:8px;color:' + impColor + '">' +
            impSign + d.imp + ' IMPs (cumulative: ' + (d.cumulative_imps >= 0 ? '+' : '') + d.cumulative_imps + ')</div>';

        // Render AI play details if dict available
        if (d.ai_dict) {
            html += renderAIPlayDetail(d.ai_dict);
        }

        panel.innerHTML = html;

        var review = document.getElementById('bp-review');
        if (review) {
            review.insertBefore(panel, review.firstChild);
        }
        G.lastDualResult = null;
    }

    function renderAIPlayDetail(dict) {
        var html = '';

        // AI Auction
        if (dict.auction && dict.auction.length > 0) {
            html += '<div style="margin-top:12px;border-top:1px solid #c5e0d0;padding-top:10px">';
            html += '<div style="font-weight:600;margin-bottom:6px;cursor:pointer" onclick="this.parentElement.querySelector(\'.bp-ai-detail\').style.display=this.parentElement.querySelector(\'.bp-ai-detail\').style.display===\'none\'?\'\':\' none\'">';
            html += 'AI Bidding & Play &#9660;</div>';
            html += '<div class="bp-ai-detail">';

            // Bidding table
            var headers = ['West', 'North', 'East', 'South'];
            var nPad = [1, 2, 3, 0][dict.dealer || 0];
            var padded = [];
            for (var p = 0; p < nPad; p++) padded.push('');
            for (var b = 0; b < dict.auction.length; b++) padded.push(dict.auction[b]);

            html += '<table style="margin:6px 0;border-collapse:collapse;font-size:0.85rem">';
            html += '<thead><tr>';
            for (var h = 0; h < 4; h++) html += '<th style="padding:2px 8px;border-bottom:1px solid #aaa">' + headers[h] + '</th>';
            html += '</tr></thead><tbody>';
            for (var r = 0; r < padded.length; r++) {
                if (r % 4 === 0) html += '<tr>';
                html += '<td style="padding:2px 8px;text-align:center">' + formatBid(padded[r]) + '</td>';
                if (r % 4 === 3) html += '</tr>';
            }
            if (padded.length % 4 !== 0) html += '</tr>';
            html += '</tbody></table>';

            // Trick-by-trick play
            var tricks = getPlayTricks(dict);
            if (tricks && tricks.length > 0) {
                html += '<table style="margin:8px 0;border-collapse:collapse;font-size:0.85rem;width:100%">';
                html += '<thead><tr><th style="padding:2px 6px">#</th><th style="padding:2px 6px">Lead</th>';
                html += '<th style="padding:2px 6px">Cards</th><th style="padding:2px 6px">Won</th></tr></thead><tbody>';
                for (var t = 0; t < tricks.length; t++) {
                    var trick = tricks[t];
                    html += '<tr>';
                    html += '<td style="padding:2px 6px;text-align:center">' + (t + 1) + '</td>';
                    html += '<td style="padding:2px 6px">' + SEAT_LABELS[trick.leader] + '</td>';
                    html += '<td style="padding:2px 6px">';
                    for (var j = 0; j < trick.cards.length; j++) {
                        var pIdx = (trick.leader + j) % 4;
                        if (j > 0) html += ' ';
                        var winStyle = (pIdx === trick.winner) ? 'font-weight:700' : '';
                        html += '<span style="' + winStyle + '">' + formatCardSymbol(trick.cards[j].card) + '</span>';
                    }
                    html += '</td>';
                    html += '<td style="padding:2px 6px">' + (trick.winner >= 0 ? SEAT_LABELS[trick.winner] : '') + '</td>';
                    html += '</tr>';
                }
                html += '</tbody></table>';
            }

            html += '</div></div>';
        }
        return html;
    }

    function showNextBoardButton() {
        var existing = document.getElementById('bp-next-board-btn');
        if (existing) existing.remove();

        var btn = document.createElement('button');
        btn.id = 'bp-next-board-btn';
        btn.textContent = 'Next Board';
        btn.style.cssText = 'display:block;margin:20px auto;padding:12px 32px;font-size:1.1rem;font-weight:700;' +
            'background:#2a7;color:#fff;border:none;border-radius:6px;cursor:pointer;';
        btn.addEventListener('click', function() {
            if (G.ws && G.ws.readyState === WebSocket.OPEN) {
                G.ws.send('next_board');
            }
            btn.disabled = true;
            btn.textContent = 'Waiting for other players...';
            btn.style.background = '#999';
        });

        var review = document.getElementById('bp-review');
        if (review) {
            review.appendChild(btn);
        }
    }

    function formatCardSymbol(sym) {
        if (!sym || sym.length < 2) return sym || '';
        var suitMap = { 'S': '\u2660', 'H': '\u2665', 'D': '\u2666', 'C': '\u2663' };
        var clsMap = { 'S': 'bp-pc-s', 'H': 'bp-pc-h', 'D': 'bp-pc-d', 'C': 'bp-pc-c' };
        var s = sym[0].toUpperCase();
        var r = sym[1].toUpperCase();
        return '<span class="' + (clsMap[s] || '') + '">' + r + (suitMap[s] || s) + '</span>';
    }

    function renderReviewSummary(dict) {
        var el = document.getElementById('bp-review-summary');

        if (G.mode === 'bidding') {
            el.innerHTML = renderBiddingPracticeSummary(dict);
            return;
        }

        // Full mode & playing mode: show actual play result + contract comparison + DD table
        var html = '';

        // Actual play result
        html += '<div class="bp-review-result">';
        if (dict.contract) {
            html += '<div class="bp-review-result-item">';
            html += '<span class="bp-review-result-label">Contract</span>';
            html += '<span class="bp-review-result-value">' + formatContractText(dict.contract) + '</span>';
            html += '</div>';
        }
        if (dict.declarer !== undefined) {
            html += '<div class="bp-review-result-item">';
            html += '<span class="bp-review-result-label">Declarer</span>';
            html += '<span class="bp-review-result-value">' + SEAT_LABELS[dict.declarer] + '</span>';
            html += '</div>';
        }
        html += '<div class="bp-review-result-item">';
        html += '<span class="bp-review-result-label">Tricks</span>';
        html += '<span class="bp-review-result-value">NS ' + G.tricksCount[0] + ' - EW ' + G.tricksCount[1] + '</span>';
        html += '</div>';
        if (dict.contract && dict.declarer !== undefined) {
            var level = parseInt(dict.contract[0]);
            var needed = level + 6;
            var declSide = dict.declarer % 2;
            var taken = G.tricksCount[declSide];
            var diff = taken - needed;
            var diffStr = diff === 0 ? 'Made' : (diff > 0 ? '+' + diff : '' + diff);
            var diffClass = diff >= 0 ? 'bp-quality-good' : 'bp-quality-bad';
            html += '<div class="bp-review-result-item">';
            html += '<span class="bp-review-result-label">Result</span>';
            html += '<span class="bp-review-result-value ' + diffClass + '">' + diffStr + '</span>';
            html += '</div>';
        }
        html += '</div>';

        // Contract comparison panels (You vs BEN vs Par) + DD table — for full mode
        if (G.mode !== 'playing') {
            var humanParsed = parseContract(dict.contract);
            var aiParsed = parseContract(dict.ai_contract);
            var parInfo = parseParDisplay(dict.par_display);
            var ddTable = dict.dd_table;
            var vulNS = dict.vuln_ns;
            var vulEW = dict.vuln_ew;

            var humanTricks = dict.dd_tricks;
            var humanScore = null;
            if (humanParsed && humanTricks !== undefined) {
                humanScore = nsScore(humanParsed, humanTricks, vulNS, vulEW);
            }

            var aiTricks = null, aiScore = null;
            if (aiParsed && ddTable) {
                aiTricks = ddLookup(ddTable, aiParsed.strainIdx, aiParsed.declarerIdx);
                if (aiTricks !== null) aiScore = nsScore(aiParsed, aiTricks, vulNS, vulEW);
            }

            var parTricks = null, parScoreVal = dict.par_score;
            if (parInfo && ddTable) {
                var parHands = parInfo.side === 'NS' ? [0, 2] : [1, 3];
                var t0 = ddLookup(ddTable, parInfo.strainIdx, parHands[0]);
                var t1 = ddLookup(ddTable, parInfo.strainIdx, parHands[1]);
                parTricks = (t0 !== null && t1 !== null) ? Math.max(t0, t1) : (t0 || t1);
            }

            html += '<div class="bp-review-result">';
            html += buildContractPanel('You (DD)', dict.contract,
                humanTricks, humanParsed ? humanParsed.level : null, humanScore);
            if (dict.ai_contract !== undefined) {
                html += buildContractPanel('BEN', dict.ai_contract,
                    aiTricks, aiParsed ? aiParsed.level : null, aiScore);
            } else {
                html += '<div class="bp-review-result-item">';
                html += '<span class="bp-review-result-label">BEN</span>';
                html += '<span class="bp-review-result-value bp-loading-text">Analyzing\u2026</span>';
                html += '</div>';
            }
            html += buildContractPanel('Par', dict.par_display ? dict.par_display.replace(/\s*\(.*\)/, '') : null,
                parTricks, parInfo ? parInfo.level : null, parScoreVal);
            html += '</div>';

            if (ddTable) {
                html += renderDDTable(ddTable);
            }
        }

        el.innerHTML = html;
    }

    function buildContractPanel(label, contractStr, tricks, level, score) {
        var html = '<div class="bp-review-result-item">';
        html += '<span class="bp-review-result-label">' + label + '</span>';
        html += '<span class="bp-review-result-value">' + (contractStr ? formatContractText(contractStr) : 'All Pass') + '</span>';
        if (level !== null && tricks !== null && tricks !== undefined) {
            html += '<span class="bp-review-result-label">DD Result</span>';
            var needed = level + 6;
            var diff = tricks - needed;
            var tag = diff === 0 ? '=' : diff > 0 ? '+' + diff : '' + diff;
            var cls = diff >= 0 ? 'bp-score-pos' : 'bp-score-neg';
            html += '<span class="bp-review-result-value ' + cls + '">' + tricks + ' tricks (' + tag + ')</span>';
        }
        if (score !== null && score !== undefined) {
            html += '<span class="bp-review-result-label">Score</span>';
            var sCls = score > 0 ? 'bp-score-pos' : score < 0 ? 'bp-score-neg' : 'bp-score-zero';
            var sStr = score > 0 ? '+' + score : '' + score;
            html += '<span class="bp-review-result-value ' + sCls + '">' + sStr + '</span>';
        }
        html += '</div>';
        return html;
    }

    function renderBiddingPracticeSummary(dict) {
        var html = '<div class="bp-review-panels">';

        var humanParsed = parseContract(dict.contract);
        var aiParsed = parseContract(dict.ai_contract);
        var parInfo = parseParDisplay(dict.par_display);
        var ddTable = dict.dd_table;
        var vulNS = dict.vuln_ns;
        var vulEW = dict.vuln_ew;

        // Human
        var humanTricks = dict.dd_tricks;
        var humanScore = null;
        if (humanParsed && humanTricks !== undefined) {
            humanScore = nsScore(humanParsed, humanTricks, vulNS, vulEW);
        }

        // AI
        var aiTricks = null, aiScore = null;
        if (aiParsed && ddTable) {
            aiTricks = ddLookup(ddTable, aiParsed.strainIdx, aiParsed.declarerIdx);
            if (aiTricks !== null) aiScore = nsScore(aiParsed, aiTricks, vulNS, vulEW);
        }

        // Par
        var parTricks = null, parScoreVal = dict.par_score;
        if (parInfo && ddTable) {
            var parHands = parInfo.side === 'NS' ? [0, 2] : [1, 3];
            var t0 = ddLookup(ddTable, parInfo.strainIdx, parHands[0]);
            var t1 = ddLookup(ddTable, parInfo.strainIdx, parHands[1]);
            parTricks = (t0 !== null && t1 !== null) ? Math.max(t0, t1) : (t0 || t1);
        }

        // Three contract panels
        html += '<div class="bp-review-result">';
        html += buildContractPanel('You', dict.contract,
            humanTricks, humanParsed ? humanParsed.level : null, humanScore);
        if (dict.ai_contract !== undefined) {
            html += buildContractPanel('BEN', dict.ai_contract,
                aiTricks, aiParsed ? aiParsed.level : null, aiScore);
        } else {
            html += '<div class="bp-review-result-item">';
            html += '<span class="bp-review-result-label">BEN</span>';
            html += '<span class="bp-review-result-value bp-loading-text">Analyzing\u2026</span>';
            html += '</div>';
        }
        html += buildContractPanel('Par', dict.par_display ? dict.par_display.replace(/\s*\(.*\)/, '') : null,
            parTricks, parInfo ? parInfo.level : null, parScoreVal);
        html += '</div>';

        // DD table
        if (ddTable) {
            html += renderDDTable(ddTable);
        }

        html += '</div>';
        return html;
    }

    function renderDDTable(table) {
        // table[strain][hand]: strains S=0,H=1,D=2,C=3,NT=4; hands N=0,E=1,S=2,W=3
        var strains = [
            {label: 'NT', cls: ''},
            {label: '\u2660', cls: 'bp-bid-suit-s'},
            {label: '\u2665', cls: 'bp-bid-suit-h'},
            {label: '\u2666', cls: 'bp-bid-suit-d'},
            {label: '\u2663', cls: 'bp-bid-suit-c'}
        ];
        // DDS strain order: S=0,H=1,D=2,C=3,NT=4 → display NT,S,H,D,C
        var strainIdx = [4, 0, 1, 2, 3];
        var hands = ['N', 'E', 'S', 'W'];

        var html = '<div class="bp-dd-table"><table>';
        html += '<thead><tr><th></th>';
        for (var h = 0; h < 4; h++) html += '<th>' + hands[h] + '</th>';
        html += '</tr></thead><tbody>';
        for (var si = 0; si < 5; si++) {
            var s = strainIdx[si];
            html += '<tr><td class="bp-dd-strain">';
            if (strains[si].cls) html += '<span class="' + strains[si].cls + '">' + strains[si].label + '</span>';
            else html += strains[si].label;
            html += '</td>';
            for (var h = 0; h < 4; h++) {
                var tricks = table[s][h];
                var cls = tricks >= 7 ? 'bp-dd-make' : 'bp-dd-fail';
                html += '<td class="' + cls + '">' + tricks + '</td>';
            }
            html += '</tr>';
        }
        html += '</tbody></table></div>';
        return html;
    }

    function renderBiddingReview(dict) {
        var bids = dict.bids;
        if (!bids || bids.length === 0) {
            hide('#bp-review-bidding');
            return;
        }

        show('#bp-review-bidding');
        var content = document.getElementById('bp-review-bidding-content');

        // Collect rows
        var rows = [];

        for (var i = 0; i < bids.length; i++) {
            var b = bids[i];
            if (!b.bid || b.bid === 'PAD_START') continue;

            var playerIdx = (dict.dealer + i) % 4;
            var isHuman = b.who === 'Human';
            var actualBid = b.bid;
            var aiBest = '';
            var aiScore = '';
            var quality = 'bp-q-neutral';

            if (isHuman && b.candidates && b.candidates.length > 0) {
                aiBest = b.candidates[0].call;
                aiScore = b.candidates[0].insta_score !== undefined ?
                    b.candidates[0].insta_score.toFixed(3) : '';

                if (aiBest === actualBid) {
                    quality = 'bp-q-good';
                } else {
                    var actualScore = -1;
                    var bestScore = b.candidates[0].insta_score || 0;
                    for (var c = 0; c < b.candidates.length; c++) {
                        if (b.candidates[c].call === actualBid) {
                            actualScore = b.candidates[c].insta_score || 0;
                            break;
                        }
                    }
                    if (actualScore >= 0 && bestScore > 0) {
                        var ratio = actualScore / bestScore;
                        quality = ratio > 0.8 ? 'bp-q-ok' : 'bp-q-bad';
                    } else {
                        quality = 'bp-q-ok';
                    }
                }
            }

            rows.push({
                num: i + 1,
                player: SEAT_LABELS[playerIdx],
                bid: actualBid,
                aiBest: aiBest,
                aiScore: aiScore,
                quality: quality,
                isHuman: isHuman,
                explanation: b.explanation || ''
            });
        }

        var html = '';
        html += '<table class="bp-review-bid-table">';
        html += '<thead><tr><th>Seat</th><th>Bid</th><th>BEN</th><th></th><th>Explanation</th></tr></thead>';
        html += '<tbody>';

        for (var r = 0; r < rows.length; r++) {
            var row = rows[r];
            var trClass = row.isHuman ? ' class="bp-bid-human-row"' : '';
            html += '<tr' + trClass + '>';
            html += '<td>' + row.player + '</td>';
            html += '<td>' + formatBid(row.bid) + '</td>';
            html += '<td>' + (row.isHuman ? formatBid(row.aiBest) : '') + '</td>';
            html += '<td>' + (row.isHuman ? '<span class="bp-quality-dot ' + row.quality + '"></span>' : '') + '</td>';
            html += '<td class="bp-bid-explain">' + formatExplanation(row.explanation) + '</td>';
            html += '</tr>';
        }

        html += '</tbody></table>';
        content.innerHTML = html;
    }

    function getPlayTricks(dict) {
        // Group play entries into tricks of 4 cards
        var play = dict.play || [];
        var tricks = [];
        var leader = dict.declarer !== undefined ? (dict.declarer + 1) % 4 : 0;

        for (var i = 0; i < play.length; i += 4) {
            var trickCards = [];
            for (var j = 0; j < 4 && (i + j) < play.length; j++) {
                trickCards.push(play[i + j]);
            }
            // trick_winners from server are RELATIVE (0=lefty,1=dummy,2=righty,3=declarer)
            // Convert to ABSOLUTE (0=N,1=E,2=S,3=W): abs = (declarer + 1 + rel) % 4
            var relWinner = dict.trick_winners && dict.trick_winners[tricks.length] !== undefined
                ? dict.trick_winners[tricks.length] : -1;
            var winner = relWinner >= 0 ? (dict.declarer + 1 + relWinner) % 4 : -1;
            tricks.push({ cards: trickCards, leader: leader, winner: winner });
            if (winner >= 0) leader = winner;
        }
        return tricks;
    }

    function assessCardQuality(cardResp) {
        // Assess how good the played card was vs the best candidate
        if (!cardResp.candidates || cardResp.candidates.length <= 1) {
            return { quality: 'neutral', loss: 0 };
        }

        var cands = cardResp.candidates;
        var played = cardResp.card;

        // Use expected_tricks_dd if available, else expected_tricks_sd, else insta_score
        var metric = 'expected_tricks_dd';
        if (cands[0][metric] === undefined) metric = 'expected_tricks_sd';
        if (cands[0][metric] === undefined) metric = 'insta_score';
        if (cands[0][metric] === undefined) {
            return { quality: 'neutral', loss: 0 };
        }

        var bestVal = cands[0][metric];
        var playedVal = bestVal;
        for (var c = 0; c < cands.length; c++) {
            if (cands[c].card === played) {
                playedVal = cands[c][metric];
                break;
            }
        }

        // For tricks, declarer wants more; for defenders, we compare absolute difference
        var loss = Math.abs(bestVal - playedVal);

        if (loss < 0.2) return { quality: 'good', loss: loss };
        if (loss < 0.8) return { quality: 'ok', loss: loss };
        return { quality: 'bad', loss: loss };
    }

    function renderPlayReview(dict, trickIdx) {
        var tricks = getPlayTricks(dict);
        if (!tricks || tricks.length === 0) {
            hide('#bp-review-play');
            return;
        }

        show('#bp-review-play');
        G.reviewTrickIdx = Math.max(0, Math.min(trickIdx, tricks.length - 1));

        var label = document.getElementById('bp-review-trick-label');
        label.textContent = 'Trick ' + (G.reviewTrickIdx + 1) + ' of ' + tricks.length;

        var trick = tricks[G.reviewTrickIdx];
        var content = document.getElementById('bp-review-play-content');
        var html = '<div class="bp-review-trick-row">';

        for (var j = 0; j < trick.cards.length; j++) {
            var cr = trick.cards[j];
            var playerIdx = (trick.leader + j) % 4;
            var assessment = assessCardQuality(cr);
            var qClass = 'bp-rv-' + assessment.quality;
            if (assessment.quality === 'neutral') qClass = '';
            var winClass = (playerIdx === trick.winner) ? ' bp-rv-winner' : '';

            html += '<div class="bp-review-card-box ' + qClass + winClass + '">';
            html += '<div class="bp-review-card-player">' + SEAT_LABELS[playerIdx];
            if (playerIdx === trick.winner) html += ' &#9733;';
            html += '</div>';
            html += '<div class="bp-review-card-played">' + formatCardSymbol(cr.card) + '</div>';

            // Analysis
            if (cr.candidates && cr.candidates.length > 0) {
                html += '<div class="bp-review-card-analysis">';

                // Show if not best
                if (assessment.quality !== 'good' && assessment.quality !== 'neutral' && assessment.loss > 0) {
                    html += '<div class="bp-review-loss">Loss: ~' + assessment.loss.toFixed(1) + ' tricks</div>';
                    html += '<div>Best: <span class="bp-review-best">' + formatCardSymbol(cr.candidates[0].card) + '</span></div>';
                }

                // Candidates table: show top 6, or top 4 + ... + actual if played card is outside top 6
                html += '<div class="bp-review-cands"><table>';
                html += '<thead><tr><th>Card</th><th>DD Tricks</th><th>P(make)</th></tr></thead><tbody>';
                var actualRank = -1;
                for (var c = 0; c < cr.candidates.length; c++) {
                    if (cr.candidates[c].card === cr.card) { actualRank = c; break; }
                }
                var inTop6 = actualRank >= 0 && actualRank < 6;
                var showCount = inTop6 ? Math.min(cr.candidates.length, 6) : Math.min(cr.candidates.length, 4);
                for (var c = 0; c < showCount; c++) {
                    var cand = cr.candidates[c];
                    var isActual = cand.card === cr.card;
                    html += '<tr' + (isActual ? ' class="bp-cand-actual"' : '') + '>';
                    html += '<td>' + formatCardSymbol(cand.card) + '</td>';
                    html += '<td>' + (cand.expected_tricks_dd !== undefined ? cand.expected_tricks_dd.toFixed(2) : (cand.expected_tricks_sd !== undefined ? cand.expected_tricks_sd.toFixed(2) : '-')) + '</td>';
                    html += '<td>' + (cand.p_make_contract !== undefined ? (cand.p_make_contract * 100).toFixed(0) + '%' : '-') + '</td>';
                    html += '</tr>';
                }
                if (!inTop6 && actualRank >= 0) {
                    var ac = cr.candidates[actualRank];
                    html += '<tr class="bp-cand-gap"><td colspan="3">#' + (actualRank + 1) + ' of ' + cr.candidates.length + '</td></tr>';
                    html += '<tr class="bp-cand-actual">';
                    html += '<td>' + formatCardSymbol(ac.card) + '</td>';
                    html += '<td>' + (ac.expected_tricks_dd !== undefined ? ac.expected_tricks_dd.toFixed(2) : (ac.expected_tricks_sd !== undefined ? ac.expected_tricks_sd.toFixed(2) : '-')) + '</td>';
                    html += '<td>' + (ac.p_make_contract !== undefined ? (ac.p_make_contract * 100).toFixed(0) + '%' : '-') + '</td>';
                    html += '</tr>';
                }
                html += '</tbody></table></div>';
                html += '</div>';
            } else if (!cr.candidates || cr.candidates.length === 0) {
                html += '<div class="bp-review-card-analysis bp-analysis-pending">No analysis (forced play)</div>';
            }

            html += '</div>';
        }

        html += '</div>';
        // "Play from here" button for 复盘
        if (G.lastPbn && G.reviewDict) {
            html += '<div style="margin-top:10px;text-align:center">';
            html += '<button class="bp-btn-sm bp-explore-btn" data-trick="' + G.reviewTrickIdx + '">Play from trick ' + (G.reviewTrickIdx + 1) + '</button>';
            html += '</div>';
        }
        content.innerHTML = html;

        // Wire up explore button
        var exploreBtn = content.querySelector('.bp-explore-btn');
        if (exploreBtn) {
            exploreBtn.addEventListener('click', function() {
                startExploreFromTrick(parseInt(this.getAttribute('data-trick')));
            });
        }

        // Update nav button states
        document.getElementById('bp-review-prev').disabled = G.reviewTrickIdx === 0;
        document.getElementById('bp-review-next').disabled = G.reviewTrickIdx >= tricks.length - 1;
    }

    function startExploreFromTrick(trickIdx) {
        if (!G.lastPbn || !G.reviewDict) return;
        var dict = G.reviewDict;
        var play = dict.play || [];

        // Collect all card symbols played before the target trick
        var cardsToAutoPlay = [];
        for (var i = 0; i < trickIdx * 4 && i < play.length; i++) {
            cardsToAutoPlay.push(play[i].card);
        }

        // Save review state
        G.savedReviewDict = dict;
        G.replayCards = cardsToAutoPlay;
        G.replayIdx = 0;
        G.replayMode = false; // becomes true when fast-forward completes

        // Close current game
        if (G.ws) { G.ws.close(); G.ws = null; }
        G.phase = 'setup';

        // Hide review, show game
        hide('#bp-review');
        hide('#bp-feedback-dialog');

        // Build connection params — same deal, play_only with original auction
        var vulStr = 'None';
        if (G.vuln[0] && G.vuln[1]) vulStr = 'Both';
        else if (G.vuln[0]) vulStr = 'N-S';
        else if (G.vuln[1]) vulStr = 'E-W';
        var auctionBids = (dict.auction || []).join(' ');
        var dealParam = "('" + G.lastPbn + "', '" + 'NESW'[G.dealer] + ' ' + vulStr + ' ' + auctionBids + "')";
        var params = [
            'board_no=' + G.boardNo,
            'deal=' + dealParam,
            'S=x',
            'H=x',
            'P=5',
            'A=x',
            'T=0'
        ];

        // All seats AI for bidding; human takes over at target
        G.humanSeats = [false, false, true, false];
        G.noHuman = false;

        var server = document.getElementById('bp-server') ?
            document.getElementById('bp-server').value : '3';
        params.push('server=' + server);
        var port = WS_PORT;
        var url = buildWsUrl(port, params);

        // Disable the 2s card delay during fast-forward
        _lastCardTime = 0;

        startGame(url, port);
    }

    function backToReview() {
        if (G.ws) { G.ws.close(); G.ws = null; }
        G.replayMode = false;
        G.replayCards = null;
        hide('#bp-back-to-review');

        if (G.savedReviewDict) {
            G.reviewDict = G.savedReviewDict;
            G.savedReviewDict = null;
            G.phase = 'ended';
            showReview(G.reviewDict);
        }
    }

    function renderKeyMoments(dict) {
        var tricks = getPlayTricks(dict);
        var bids = dict.bids || [];
        if ((!tricks || tricks.length === 0) && bids.length === 0) {
            hide('#bp-review-errors');
            return;
        }

        var moments = [];

        // Check bids
        for (var bi = 0; bi < bids.length; bi++) {
            var b = bids[bi];
            if (!b.bid || b.bid === 'PAD_START' || !b.candidates || b.candidates.length <= 1) continue;
            var aiBest = b.candidates[0];
            if (aiBest.call !== b.bid) {
                var bestScore = aiBest.insta_score || 0;
                var actualScore = 0;
                for (var bc = 0; bc < b.candidates.length; bc++) {
                    if (b.candidates[bc].call === b.bid) {
                        actualScore = b.candidates[bc].insta_score || 0;
                        break;
                    }
                }
                if (bestScore > 0) {
                    var ratio = actualScore / bestScore;
                    if (ratio < 0.8) {
                        var playerIdx = (dict.dealer + bi) % 4;
                        moments.push({
                            type: 'bid',
                            label: 'Bid ' + (bi + 1),
                            desc: SEAT_LABELS[playerIdx] + ' bid ' + b.bid + ', AI preferred ' + aiBest.call,
                            severity: ratio < 0.5 ? 'bad' : 'ok'
                        });
                    }
                }
            }
        }

        // Check play
        for (var ti = 0; ti < tricks.length; ti++) {
            for (var ci = 0; ci < tricks[ti].cards.length; ci++) {
                var cr = tricks[ti].cards[ci];
                var assessment = assessCardQuality(cr);
                if (assessment.quality === 'bad' || (assessment.quality === 'ok' && assessment.loss >= 0.5)) {
                    var pIdx = (tricks[ti].leader + ci) % 4;
                    moments.push({
                        type: 'play',
                        trickIdx: ti,
                        label: 'Trick ' + (ti + 1),
                        desc: SEAT_LABELS[pIdx] + ' played ' + cr.card +
                            (cr.candidates && cr.candidates.length > 0 ? ', best was ' + cr.candidates[0].card : ''),
                        loss: assessment.loss,
                        severity: assessment.quality
                    });
                }
            }
        }

        var content = document.getElementById('bp-review-errors-content');
        if (moments.length === 0) {
            content.innerHTML = '<div class="bp-review-none">No significant mistakes detected</div>';
            show('#bp-review-errors');
            return;
        }

        var html = '';
        for (var m = 0; m < moments.length; m++) {
            var mom = moments[m];
            html += '<div class="bp-review-moment bp-moment-' + mom.severity + '"';
            if (mom.type === 'play' && mom.trickIdx !== undefined) {
                html += ' data-trick="' + mom.trickIdx + '"';
            }
            html += '>';
            html += '<span class="bp-review-moment-trick">' + mom.label + '</span>';
            html += '<span class="bp-review-moment-desc">' + mom.desc + '</span>';
            if (mom.loss !== undefined) {
                html += '<span class="bp-review-moment-loss">-' + mom.loss.toFixed(1) + '</span>';
            }
            html += '</div>';
        }
        content.innerHTML = html;
        show('#bp-review-errors');

        // Click to navigate to trick
        content.querySelectorAll('.bp-review-moment[data-trick]').forEach(function(el) {
            el.addEventListener('click', function() {
                var idx = parseInt(this.getAttribute('data-trick'));
                renderPlayReview(G.reviewDict, idx);
                document.getElementById('bp-review-play').scrollIntoView({ behavior: 'smooth' });
            });
        });
    }

    function initReviewNav() {
        document.getElementById('bp-review-prev').addEventListener('click', function() {
            if (G.reviewDict && G.reviewTrickIdx > 0) {
                renderPlayReview(G.reviewDict, G.reviewTrickIdx - 1);
            }
        });
        document.getElementById('bp-review-next').addEventListener('click', function() {
            if (G.reviewDict) {
                renderPlayReview(G.reviewDict, G.reviewTrickIdx + 1);
            }
        });
    }

    // === Connection ===

    function connectMultiplayer() {
        var urlParams = new URLSearchParams(window.location.search);
        var roomId = urlParams.get('room');
        var seat = urlParams.get('seat');
        var humanSeats = urlParams.get('human_seats') || '';
        var boardSeed = urlParams.get('board_seed') || '1';
        var server = urlParams.get('server') || '3';
        var mode = urlParams.get('mode') || 'casual';
        var numRounds = urlParams.get('num_rounds') || '0';
        var table = urlParams.get('table') || '1';

        G.multiplayer = true;
        G.roomId = roomId;
        G.mySeat = 'NESW'.indexOf(seat);
        G.mpHumanSeats = humanSeats;
        G.sessionMode = mode;
        G.noHuman = false;

        // Set humanSeats for this client — all seats listed in human_seats are human
        G.humanSeats = [false, false, false, false];
        for (var i = 0; i < humanSeats.length; i++) {
            var idx = 'NESW'.indexOf(humanSeats[i]);
            if (idx >= 0) G.humanSeats[idx] = true;
        }

        var params = [
            'room=' + roomId,
            'seat=' + seat,
            'human_seats=' + humanSeats,
            'board_seed=' + boardSeed,
            'mode=' + mode,
            'num_rounds=' + numRounds,
            'table=' + table
        ];

        params.push('server=' + server);
        var port = WS_PORT;
        var url = buildWsUrl(port, params);

        setStatus('Connecting to multiplayer room...');
        show('#bp-loader');
        startGame(url, port);
    }

    function connectToGame() {
        var params = [];

        // In mode-based games, skip setup panel config
        if (G.mode === 'bidding' || G.mode === 'playing') {
            var boardNo = Math.floor(Math.random() * 2000000000) + 1;
            params.push('board_no=' + boardNo);

            if (G.mode === 'bidding') {
                // Human bids as South, AI handles rest
                G.humanSeats = [false, false, true, false];
                params.push('S=x');
                params.push('bidding_only=True');
            } else {
                // AI bids all 4 seats, then human plays South
                // Show South's hand during auto-bidding so player can follow along
                G.humanSeats = [false, false, true, false];
                G.noHuman = false;
                params.push('auto_bid=True');
                params.push('H=x');
            }
            params.push('A=x');
            params.push('T=2');

            var server = document.getElementById('bp-server') ?
                document.getElementById('bp-server').value : '3';
            params.push('server=' + server);
            var port = WS_PORT;
            var url = buildWsUrl(port, params);

            show('#bp-loader');
            startGame(url, port);
            return;
        }

        var dealType = document.querySelector('input[name="bp-deal-type"]:checked').value;
        if (dealType === 'manual') {
            var dealText = document.getElementById('bp-deal-text').value.trim().toUpperCase();
            var dealer = document.getElementById('bp-dealer').value;
            var vul = document.getElementById('bp-vul').value;
            if (!dealText) {
                alert('Please enter the deal.');
                return;
            }
            var dealParam = "('" + dealText + "', '" + dealer + " " + vul + "')";
            params.push('deal=' + dealParam);
        }

        var boardNo = document.getElementById('bp-board-no').value.trim();
        if (!boardNo) {
            boardNo = Math.floor(Math.random() * 2000000000) + 1;
        }
        params.push('board_no=' + boardNo);

        G.humanSeats = [
            document.getElementById('bp-human-N').checked,
            document.getElementById('bp-human-E').checked,
            document.getElementById('bp-human-S').checked,
            document.getElementById('bp-human-W').checked
        ];
        G.noHuman = !G.humanSeats[0] && !G.humanSeats[1] && !G.humanSeats[2] && !G.humanSeats[3];

        if (G.humanSeats[0]) params.push('N=x');
        if (G.humanSeats[1]) params.push('E=x');
        if (G.humanSeats[2]) params.push('S=x');
        if (G.humanSeats[3]) params.push('W=x');
        if (document.getElementById('bp-human-declares').checked) params.push('H=x');
        if (document.getElementById('bp-matchpoint').checked) params.push('M=x');
        params.push('A=x'); // autocomplete
        params.push('T=2'); // timeout

        var server = document.getElementById('bp-server').value;
        params.push('server=' + server);
        var port = WS_PORT;
        var url = buildWsUrl(port, params);

        show('#bp-loader');
        startGame(url, port);
    }

    var _keepAliveTimer = null;

    function startKeepAlive() {
        stopKeepAlive();
        _keepAliveTimer = setInterval(function() {
            if (G.ws && G.ws.readyState === WebSocket.OPEN) {
                G.ws.send('ping');
            }
        }, 30000);
    }

    function stopKeepAlive() {
        if (_keepAliveTimer) { clearInterval(_keepAliveTimer); _keepAliveTimer = null; }
    }

    function startGame(url, port) {
        G.ws = new WebSocket(url);
        G.ws.onopen = function() {
            hide('#bp-setup');
            show('#bp-game');
            hide('#bp-loader');
            startKeepAlive();
        };
        G.ws.onmessage = handleMessage;
        G.ws.onerror = function(e) {
            console.error('WebSocket error:', e);
            hide('#bp-loader');
            alert('Cannot connect to BEN server on port ' + port + '.\nIs the server running?\nStart it with: python gameserver.py');
        };
        G.ws.onclose = function(e) {
            stopKeepAlive();
            if (!e.wasClean) {
                console.error('Connection died');
            }
        };
    }

    // === Setup UI ===

    function initSetup() {
        document.querySelectorAll('input[name="bp-deal-type"]').forEach(function(radio) {
            radio.addEventListener('change', function() {
                var manual = this.value === 'manual';
                document.getElementById('bp-deal-input').style.display = manual ? '' : 'none';
                document.getElementById('bp-manual-opts').style.display = manual ? '' : 'none';
            });
        });

        document.getElementById('bp-start').addEventListener('click', connectToGame);

        document.getElementById('bp-new-game').addEventListener('click', function() {
            if (G.ws) { G.ws.close(); G.ws = null; }
            hide('#bp-game');
            hide('#bp-review');
            hide('#bp-feedback-dialog');
            G.phase = 'setup';
            G.reviewDict = null;

            if (G.multiplayer) {
                // In multiplayer, go back to lobby
                window.location.href = 'lobby.html';
            } else if (G.mode === 'bidding' || G.mode === 'playing') {
                // In mode-based games, start a new game directly
                connectToGame();
            } else {
                show('#bp-setup');
            }
        });

        document.getElementById('bp-replay').addEventListener('click', function() {
            if (!G.lastPbn || !G.boardNo) return;
            if (G.ws) { G.ws.close(); G.ws = null; }
            hide('#bp-review');
            hide('#bp-feedback-dialog');
            G.phase = 'setup';
            G.reviewDict = null;

            // Replay same deal with same bidding: pass deal + dealer/vul to server
            var vulStr = 'None';
            if (G.vuln[0] && G.vuln[1]) vulStr = 'Both';
            else if (G.vuln[0]) vulStr = 'N-S';
            else if (G.vuln[1]) vulStr = 'E-W';
            var dealParam = "('" + G.lastPbn + "', '" + 'NESW'[G.dealer] + ' ' + vulStr + "')";
            var params = [
                'board_no=' + G.boardNo,
                'deal=' + dealParam
            ];

            if (G.mode === 'playing') {
                G.humanSeats = [false, false, true, false];
                G.noHuman = false;
                params.push('auto_bid=True');
                params.push('H=x');
            } else {
                // Use current human seat settings
                if (G.humanSeats[0]) params.push('N=x');
                if (G.humanSeats[1]) params.push('E=x');
                if (G.humanSeats[2]) params.push('S=x');
                if (G.humanSeats[3]) params.push('W=x');
                var hd = document.getElementById('bp-human-declares');
                if (hd && hd.checked) params.push('H=x');
                var mp = document.getElementById('bp-matchpoint');
                if (mp && mp.checked) params.push('M=x');
            }
            params.push('A=x');
            params.push('T=2');

            var server = document.getElementById('bp-server') ?
                document.getElementById('bp-server').value : '3';
            params.push('server=' + server);
            var port = WS_PORT;
            var url = buildWsUrl(port, params);
            show('#bp-loader');
            startGame(url, port);
        });

        document.getElementById('bp-back-to-review').addEventListener('click', backToReview);

        document.getElementById('bp-restart-bidding').addEventListener('click', function() {
            if (!G.boardNo) return;
            if (G.ws) { G.ws.close(); G.ws = null; }
            hide('#bp-review');
            hide('#bp-feedback-dialog');
            G.phase = 'setup';
            G.reviewDict = null;

            // Reconnect with the same board number — same deal, re-bid
            var params = [
                'board_no=' + G.boardNo
            ];

            if (G.mode === 'bidding') {
                // Bidding practice: human bids South only
                params.push('S=x');
                params.push('bidding_only=True');
                G.humanSeats = [false, false, true, false];
            } else {
                // Full mode: use current human seat settings for a full game
                if (G.humanSeats[0]) params.push('N=x');
                if (G.humanSeats[1]) params.push('E=x');
                if (G.humanSeats[2]) params.push('S=x');
                if (G.humanSeats[3]) params.push('W=x');
                var hd = document.getElementById('bp-human-declares');
                if (hd && hd.checked) params.push('H=x');
                var mp = document.getElementById('bp-matchpoint');
                if (mp && mp.checked) params.push('M=x');
            }
            params.push('A=x');
            params.push('T=2');

            var server = document.getElementById('bp-server') ?
                document.getElementById('bp-server').value : '3';
            params.push('server=' + server);
            var port = WS_PORT;
            var url = buildWsUrl(port, params);
            show('#bp-loader');
            startGame(url, port);
        });

        document.addEventListener('click', function(e) {
            if (e.target.closest('.bp-hand, .bp-side-panel, .bp-overlay, .bp-dialog, .bp-hint-panel')) return;
            sendConfirmTrick();
        });

        document.getElementById('bp-last-trick').addEventListener('click', function(e) {
            e.stopPropagation();
            if (G.lastTrick) {
                for (var j = 0; j < G.lastTrick.cards.length; j++) {
                    var pIdx = (G.lastTrick.leadPlayer + j) % 4;
                    var card = G.lastTrick.cards[j];
                    var slots = ['bp-trick-n', 'bp-trick-e', 'bp-trick-s', 'bp-trick-w'];
                    var el = document.getElementById(slots[displayPos(pIdx)]);
                    var div = document.createElement('div');
                    div.className = 'bp-played-card ' + PC_CLASSES[card.suit];
                    div.textContent = card.rank + SUIT_SYMBOLS[card.suit];
                    div.style.opacity = '0.6';
                    el.appendChild(div);
                }
                setTimeout(clearTrickSlots, 2000);
            }
        });

        document.getElementById('bp-claim-btn').addEventListener('click', function(e) {
            e.stopPropagation();
            showClaimDialog();
        });

        document.getElementById('bp-concede-btn').addEventListener('click', function(e) {
            e.stopPropagation();
            G.ws.send('Conceed');
        });

        document.getElementById('bp-claim-cancel').addEventListener('click', function() {
            hide('#bp-claim-dialog');
        });
    }

    function showClaimDialog() {
        var dialog = document.getElementById('bp-claim-dialog');
        var opts = document.getElementById('bp-claim-options');
        opts.innerHTML = '';
        var remaining = 13 - (G.tricksCount[0] + G.tricksCount[1]);
        for (var i = 0; i <= remaining; i++) {
            var btn = document.createElement('div');
            btn.className = 'bp-claim-opt';
            btn.textContent = i;
            btn.setAttribute('data-tricks', i);
            btn.addEventListener('click', function() {
                var tricks = this.getAttribute('data-tricks');
                G.ws.send('Claim ' + tricks);
                hide(dialog);
            });
            opts.appendChild(btn);
        }
        show(dialog);
    }

    // === Session (multi-board) helpers ===

    function updateSessionBar() {
        var bar = document.getElementById('bp-session-bar');
        if (!bar) return;
        var modeLabel = document.getElementById('bp-session-mode');
        var progress = document.getElementById('bp-session-progress');
        var score = document.getElementById('bp-session-score');
        if (!modeLabel || !progress || !score) return;

        var labels = { casual: 'Casual', dual: 'Dual Table', match2v2: '2v2 Match', match4v4: '4v4 Match' };
        modeLabel.textContent = labels[G.sessionMode] || '';
        var total = G.sessionTotalBoards || '?';
        progress.textContent = 'Board ' + (G.sessionBoardIdx + 1) + ' of ' + total;

        if (G.sessionMode === 'dual') {
            var sign = G.cumulativeIMPs >= 0 ? '+' : '';
            score.textContent = 'IMPs: ' + sign + G.cumulativeIMPs;
        } else if (G.sessionMode === 'casual') {
            score.textContent = 'NS: ' + G.cumulativeScoreNS + '  EW: ' + G.cumulativeScoreEW;
        } else {
            score.textContent = '';
        }
    }

    function showBoardTransition(data) {
        var overlay = document.getElementById('bp-board-transition');
        if (!overlay) return;
        var content = document.getElementById('bp-transition-content');
        var html = '';
        if (data.contract) {
            var declLabel = data.declarer !== null && data.declarer !== undefined ? ' by ' + SEAT_LABELS[data.declarer] : '';
            html += '<div style="font-size:1.1rem;font-weight:700">' + data.contract + declLabel + '</div>';
            html += '<div>Tricks: ' + (data.tricks || 0) + '</div>';
        } else {
            html += '<div>Passed out</div>';
        }
        if (data.score_ns !== undefined) {
            var scoreText = data.score_ns >= 0 ? 'NS +' + data.score_ns : 'EW +' + (-data.score_ns);
            html += '<div style="margin-top:6px">' + scoreText + '</div>';
        }
        // Show dual table comparison if available
        if (G.lastDualResult) {
            var d = G.lastDualResult;
            var aiContract = d.ai_contract ? d.ai_contract + (d.ai_declarer != null ? ' by ' + SEAT_LABELS[d.ai_declarer] : '') : 'Passed out';
            var aiTricks = d.ai_tricks || 0;
            var yourText = d.your_score >= 0 ? '+' + d.your_score : '' + d.your_score;
            var aiText = d.ai_score >= 0 ? '+' + d.ai_score : '' + d.ai_score;
            var impSign = d.imp >= 0 ? '+' : '';
            html += '<div style="margin-top:10px;padding-top:8px;border-top:1px solid #ddd">';
            html += '<div style="font-size:0.95rem;font-weight:600;color:#555">AI Table</div>';
            html += '<div style="margin-top:4px">' + aiContract + ', ' + aiTricks + ' tricks (' + aiText + ')</div>';
            html += '<div style="font-size:1.1rem;font-weight:700;margin-top:6px;color:' + (d.imp >= 0 ? '#2a7' : '#c44') + '">' + impSign + d.imp + ' IMPs</div>';
            html += '</div>';
            G.lastDualResult = null;
        }
        html += '<div style="margin-top:8px;color:#888;font-size:0.85rem">Next board in 5 seconds...</div>';
        content.innerHTML = html;
        show(overlay);
        setTimeout(function() { hide(overlay); }, 5000);
    }

    function resetForNextBoard() {
        G.phase = 'bidding';
        G.auction = [];
        G.tricks = [];
        G.currentTrick = null;
        G.tricksCount = [0, 0];
        G.declarer = -1;
        G.dummy = -1;
        G.strain = -1;
        G.lastTrick = null;
        G.expectBidInput = false;
        G.expectCardInput = false;
        G.expectTrickConfirm = false;
        G.bidExplanations = [];
        G.bidPreviews = {};
        G.lastDualResult = null;
        _playQueue = [];
        _lastCardTime = 0;
        _trickPaused = false;
        if (_playQueueTimer) { clearTimeout(_playQueueTimer); _playQueueTimer = null; }
        clearTrickSlots();
        // Clean up session UI elements
        var dualPanel = document.getElementById('bp-dual-review');
        if (dualPanel) dualPanel.remove();
        var nextBtn = document.getElementById('bp-next-board-btn');
        if (nextBtn) nextBtn.remove();
        hide('#bp-review');
        hide('#bp-last-trick');
        hide('#bp-claim-btn');
        hide('#bp-concede-btn');
        hide('#bp-replay');
        hide('#bp-back-to-review');
        hide('#bp-board-transition');
    }

    function showSessionEnd(data) {
        var overlay = document.getElementById('bp-session-end');
        if (!overlay) return;
        var content = document.getElementById('bp-session-end-content');
        var title = document.getElementById('bp-session-end-title');
        var mode = data.mode || G.sessionMode;
        var isMatch = mode && mode.indexOf('match') === 0;

        if (isMatch) {
            title.textContent = 'Match Complete';
        } else if (mode === 'dual') {
            title.textContent = 'Session Complete';
        } else {
            title.textContent = 'Session Complete';
        }

        var html = '<div class="bp-session-summary">';

        if (mode === 'dual' || isMatch) {
            var sign = data.cumulative_imps >= 0 ? '+' : '';
            html += '<div style="font-size:1.3rem;font-weight:800;margin-bottom:12px">Total IMPs: ' + sign + data.cumulative_imps + '</div>';
        } else {
            html += '<div style="font-size:1.1rem;font-weight:700;margin-bottom:12px">NS: ' + data.cumulative_ns + ' &nbsp; EW: ' + data.cumulative_ew + '</div>';
        }

        html += '<div style="font-size:0.85rem;color:#888;margin-bottom:12px">' + data.boards_played + ' boards played</div>';

        // Board-by-board table
        var results = data.results || data.table1_results || [];
        var results2 = data.table2_results || null;

        if (results.length > 0) {
            html += '<table class="bp-imp-table"><thead><tr><th>#</th>';
            if (results2) {
                html += '<th>Table 1</th><th>Score</th><th>Table 2</th><th>Score</th><th>IMP</th>';
            } else {
                html += '<th>Contract</th><th>Tricks</th><th>Score</th>';
                if (mode === 'dual') html += '<th>AI</th><th>IMP</th>';
            }
            html += '</tr></thead><tbody>';

            for (var i = 0; i < results.length; i++) {
                var r = results[i];
                html += '<tr><td>' + (i + 1) + '</td>';
                if (results2) {
                    var r2 = results2[i] || {};
                    html += '<td>' + (r.contract || 'Pass') + '</td>';
                    html += '<td>' + (r.score_ns || 0) + '</td>';
                    html += '<td>' + (r2.contract || 'Pass') + '</td>';
                    html += '<td>' + (r2.score_ns || 0) + '</td>';
                    var diff = (r.score_ns || 0) - (r2.score_ns || 0);
                    html += '<td class="' + (diff >= 0 ? 'bp-imp-pos' : 'bp-imp-neg') + '">' + (diff >= 0 ? '+' : '') + diff + '</td>';
                } else {
                    html += '<td>' + (r.contract || 'Pass') + '</td>';
                    html += '<td>' + (r.tricks || 0) + '</td>';
                    html += '<td>' + (r.score_ns || 0) + '</td>';
                    if (mode === 'dual') {
                        html += '<td>' + (r.ai_score || 0) + '</td>';
                        html += '<td class="' + (r.imp >= 0 ? 'bp-imp-pos' : 'bp-imp-neg') + '">' + (r.imp >= 0 ? '+' : '') + (r.imp || 0) + '</td>';
                    }
                }
                html += '</tr>';
            }
            html += '</tbody></table>';
        }

        html += '</div>';
        content.innerHTML = html;
        show(overlay);

        var lobbyBtn = document.getElementById('bp-session-lobby');
        if (lobbyBtn) {
            lobbyBtn.onclick = function() { window.location.href = 'lobby.html'; };
        }
    }

    // === Init ===
    document.addEventListener('DOMContentLoaded', function() {
        var urlParams = new URLSearchParams(window.location.search);

        initSetup();
        initReviewNav();

        // Multiplayer mode: room param in URL
        if (urlParams.get('room')) {
            var mpMode = urlParams.get('mode') || 'casual';
            var modeLabels = {
                casual: 'Casual Play', dual: 'Dual Table',
                match2v2: 'Match 2v2', match4v4: 'Match 4v4'
            };
            var headerH1 = document.querySelector('.bp-header h1');
            if (headerH1) headerH1.innerHTML = '<span class="bp-brand">BEN</span> — ' + (modeLabels[mpMode] || 'Multiplayer');
            hide('#bp-setup');
            // Hide hint button in multiplayer
            var hintBtn = document.querySelector('.bp-bb-hint');
            if (hintBtn) hintBtn.style.display = 'none';
            // Match modes: hide inference panel, HCP, explanations
            if (mpMode.indexOf('match') === 0) {
                hide('#bp-inference-panel');
                G.matchHideInfo = true;
            }
            connectMultiplayer();
            return;
        }

        // Auto-start for mode-based games (skip setup panel)
        // G.mode is only for practice modes (bidding/playing), not multiplayer session modes
        G.mode = urlParams.get('mode') || null;
        if (G.mode === 'bidding' || G.mode === 'playing') {
            var titleMap = { bidding: 'Bidding Practice', playing: 'Playing Practice' };
            var headerH1 = document.querySelector('.bp-header h1');
            if (headerH1) headerH1.innerHTML = '<span class="bp-brand">BEN</span> — ' + titleMap[G.mode];
            hide('#bp-setup');
            if (G.mode === 'bidding') {
                // Hide play-only UI elements in bidding practice
                hide('#bp-actions-panel');
                hide('#bp-contract-panel');
                document.getElementById('bp-tricks-display').parentElement.style.display = 'none';
                document.getElementById('bp-explain').style.display = 'none';
                document.getElementById('bp-restart-bidding').style.display = '';
            }
            connectToGame();
        }
    });

})();
