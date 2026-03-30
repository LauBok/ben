(function () {
    'use strict';

    // ===== Constants =====
    const RANKS = ['A', 'K', 'Q', 'J', 'T', '9', '8', '7', '6', '5', '4', '3', '2'];
    const SUITS = ['S', 'H', 'D', 'C'];
    const SUIT_SYMBOLS = { S: '&spades;', H: '&hearts;', D: '&diams;', C: '&clubs;' };
    const SUIT_CLASSES = { S: 'ba-spades', H: 'ba-hearts', D: 'ba-diamonds', C: 'ba-clubs' };
    const SUIT_NAMES = { S: 'Spades', H: 'Hearts', D: 'Diamonds', C: 'Clubs' };
    const BID_SUITS = ['C', 'D', 'H', 'S', 'N'];
    const BID_SUIT_DISPLAY = {
        C: '<span class="ba-clubs">&clubs;</span>',
        D: '<span class="ba-diamonds">&diams;</span>',
        H: '<span class="ba-hearts">&hearts;</span>',
        S: '<span class="ba-spades">&spades;</span>',
        N: 'NT'
    };
    const SEATS = ['N', 'E', 'S', 'W'];
    const SEAT_NAMES = { N: 'North', E: 'East', S: 'South', W: 'West' };
    const API_PORT = 8085;

    // ===== State =====
    const STATE = {
        dealer: 'N',
        vul: '',
        seat: 'S',
        hand: new Set(),    // e.g. 'SA', 'HK', 'DT'
        auction: [],        // e.g. ['1C', 'PASS', '1S']
        selectedLevel: null // for bidding box level selection
    };

    // ===== Initialization =====
    $(function () {
        initSetup();
        initCardSelector();
        initBiddingBox();
        renderAuction();
        renderBiddingBox();

        $('#ba-pbn-apply').on('click', applyPBN);
        $('#ba-pbn').on('keydown', function (e) { if (e.key === 'Enter') applyPBN(); });
        $('#ba-get-advice').on('click', getAdvice);
        $('#ba-reset').on('click', resetAll);
    });

    // ===== Setup Panel =====
    function initSetup() {
        $('#ba-dealer').val(STATE.dealer).on('change', function () {
            STATE.dealer = $(this).val();
            STATE.auction = [];
            STATE.selectedLevel = null;
            renderAuction();
            renderBiddingBox();
            hideResults();
        });
        $('#ba-vul').val(STATE.vul).on('change', function () {
            STATE.vul = $(this).val();
            hideResults();
        });
        $('#ba-seat').val(STATE.seat).on('change', function () {
            STATE.seat = $(this).val();
            hideResults();
        });
    }

    // ===== Card Selector =====
    function initCardSelector() {
        SUITS.forEach(function (suit) {
            var container = $('#ba-cards-' + suit);
            RANKS.forEach(function (rank) {
                var btn = $('<button>')
                    .addClass('ba-card-btn')
                    .attr('data-card', suit + rank)
                    .text(rank)
                    .on('click', function () { toggleCard(suit + rank); });
                container.append(btn);
            });
        });
    }

    function toggleCard(card) {
        if (STATE.hand.has(card)) {
            STATE.hand.delete(card);
        } else {
            if (STATE.hand.size >= 13) return; // can't select more than 13
            STATE.hand.add(card);
        }
        syncUI();
    }

    function syncUI() {
        // Update button highlights
        $('.ba-card-btn').each(function () {
            var card = $(this).attr('data-card');
            $(this).toggleClass('selected', STATE.hand.has(card));
        });

        // Update card count
        var count = STATE.hand.size;
        var el = $('#ba-card-count');
        el.text(count + ' / 13 cards selected');
        el.removeClass('ba-complete ba-over');
        if (count === 13) el.addClass('ba-complete');
        else if (count > 13) el.addClass('ba-over');

        // Update hand display
        renderHandDisplay();

        // Update PBN text
        $('#ba-pbn').val(handToPBN());

        hideResults();
    }

    function renderHandDisplay() {
        var display = $('#ba-hand-display');
        if (STATE.hand.size === 0) {
            display.html('<div class="ba-hand-empty">Select 13 cards below</div>');
            return;
        }
        var html = '';
        SUITS.forEach(function (suit) {
            var cards = [];
            RANKS.forEach(function (rank) {
                if (STATE.hand.has(suit + rank)) cards.push(rank);
            });
            html += '<div class="ba-hand-suit-line">';
            html += '<span class="ba-suit-sym ' + SUIT_CLASSES[suit] + '">' + SUIT_SYMBOLS[suit] + '</span> ';
            html += (cards.length > 0 ? cards.join(' ') : '&mdash;');
            html += '</div>';
        });
        display.html(html);
    }

    function handToPBN() {
        return SUITS.map(function (suit) {
            var cards = [];
            RANKS.forEach(function (rank) {
                if (STATE.hand.has(suit + rank)) cards.push(rank);
            });
            return cards.join('');
        }).join('.');
    }

    function parseHandPBN(pbn) {
        pbn = pbn.trim().toUpperCase().replace(/_/g, '.');
        var parts = pbn.split('.');
        if (parts.length !== 4) return null;
        var cards = new Set();
        for (var i = 0; i < 4; i++) {
            var suit = SUITS[i];
            for (var j = 0; j < parts[i].length; j++) {
                var rank = parts[i][j];
                if (RANKS.indexOf(rank) === -1) return null;
                cards.add(suit + rank);
            }
        }
        if (cards.size !== 13) return null;
        return cards;
    }

    function applyPBN() {
        var pbn = $('#ba-pbn').val();
        var cards = parseHandPBN(pbn);
        if (!cards) {
            alert('Invalid hand. Enter 4 suits separated by dots with exactly 13 cards.\nExample: AKQ74.K.T3.AK7');
            return;
        }
        STATE.hand = cards;
        syncUI();
    }

    // ===== Auction =====
    function getDealerIndex() { return SEATS.indexOf(STATE.dealer); }

    function getCurrentTurnIndex() {
        return (getDealerIndex() + STATE.auction.length) % 4;
    }

    function getCurrentTurnSeat() {
        return SEATS[getCurrentTurnIndex()];
    }

    function getLastRealBid() {
        // Returns the last non-PASS bid (contract bid, X, or XX)
        for (var i = STATE.auction.length - 1; i >= 0; i--) {
            if (STATE.auction[i] !== 'PASS') return { bid: STATE.auction[i], index: i };
        }
        return null;
    }

    function getLastContractBid() {
        for (var i = STATE.auction.length - 1; i >= 0; i--) {
            var b = STATE.auction[i];
            if (b !== 'PASS' && b !== 'X' && b !== 'XX') return { bid: b, index: i };
        }
        return null;
    }

    function isAuctionOver() {
        var a = STATE.auction;
        if (a.length >= 4 && a.slice(0, 4).every(function (b) { return b === 'PASS'; })) return true;
        if (a.length >= 4) {
            var last3 = a.slice(-3);
            if (last3.every(function (b) { return b === 'PASS'; })) {
                // There must be at least one non-pass bid before these 3 passes
                var beforePasses = a.slice(0, a.length - 3);
                return beforePasses.some(function (b) { return b !== 'PASS'; });
            }
        }
        return false;
    }

    function canBid(level, suit) {
        var last = getLastContractBid();
        if (!last) return true;
        var lastLevel = parseInt(last.bid[0]);
        var lastSuitIdx = BID_SUITS.indexOf(last.bid[1]);
        var newSuitIdx = BID_SUITS.indexOf(suit);
        if (level > lastLevel) return true;
        if (level === lastLevel && newSuitIdx > lastSuitIdx) return true;
        return false;
    }

    function canDouble() {
        var a = STATE.auction;
        if (a.length === 0) return false;
        var turnIdx = getCurrentTurnIndex();
        // Walk back: skip passes, find the last action
        for (var i = a.length - 1; i >= 0; i--) {
            if (a[i] === 'PASS') continue;
            if (a[i] === 'X' || a[i] === 'XX') return false;
            // It's a contract bid - check if it was by an opponent
            var bidderIdx = (getDealerIndex() + i) % 4;
            return (bidderIdx % 2) !== (turnIdx % 2);
        }
        return false;
    }

    function canRedouble() {
        var a = STATE.auction;
        if (a.length === 0) return false;
        var turnIdx = getCurrentTurnIndex();
        for (var i = a.length - 1; i >= 0; i--) {
            if (a[i] === 'PASS') continue;
            if (a[i] === 'XX') return false;
            if (a[i] === 'X') {
                var bidderIdx = (getDealerIndex() + i) % 4;
                return (bidderIdx % 2) !== (turnIdx % 2);
            }
            return false; // contract bid, no double to redouble
        }
        return false;
    }

    function addBid(bid) {
        if (isAuctionOver()) return;
        STATE.auction.push(bid);
        STATE.selectedLevel = null;
        renderAuction();
        renderBiddingBox();
        hideResults();
    }

    function undoLastBid() {
        if (STATE.auction.length === 0) return;
        STATE.auction.pop();
        STATE.selectedLevel = null;
        renderAuction();
        renderBiddingBox();
        hideResults();
    }

    function renderAuction() {
        var container = $('#ba-auction-table');
        if (STATE.auction.length === 0 && !isAuctionOver()) {
            var turnSeat = getCurrentTurnSeat();
            container.html(
                '<table><tr><th>N</th><th>E</th><th>S</th><th>W</th></tr>' +
                '<tr>' + SEATS.map(function (s) {
                    return '<td' + (s === turnSeat ? ' class="ba-current-turn"' : '') + '>' +
                        (s === turnSeat ? '?' : '') + '</td>';
                }).join('') + '</tr></table>'
            );
            return;
        }

        var dealerIdx = getDealerIndex();
        var html = '<table><tr><th>N</th><th>E</th><th>S</th><th>W</th></tr>';

        // Build rows
        var cells = [];
        // Pad cells before dealer
        for (var p = 0; p < dealerIdx; p++) cells.push('');
        // Add bids
        STATE.auction.forEach(function (bid) {
            cells.push(formatBidHTML(bid));
        });
        // Add "?" marker for current turn if auction not over
        if (!isAuctionOver()) {
            cells.push('<span class="ba-current-turn-marker">?</span>');
        }

        // Render rows of 4
        for (var r = 0; r < cells.length; r += 4) {
            html += '<tr>';
            for (var c = 0; c < 4; c++) {
                var idx = r + c;
                var isCurrentTurn = (!isAuctionOver() && idx === cells.length - 1);
                html += '<td' + (isCurrentTurn ? ' class="ba-current-turn"' : '') + '>';
                html += (idx < cells.length ? cells[idx] : '');
                html += '</td>';
            }
            html += '</tr>';
        }
        html += '</table>';
        container.html(html);
    }

    function formatBidHTML(bid) {
        if (bid === 'PASS') return '<span class="ba-bid-pass">Pass</span>';
        if (bid === 'X') return '<span class="ba-bid-double">Dbl</span>';
        if (bid === 'XX') return '<span class="ba-bid-redouble">Rdbl</span>';
        var level = bid[0];
        var suit = bid[1];
        return level + BID_SUIT_DISPLAY[suit];
    }

    // ===== Bidding Box =====
    function initBiddingBox() {
        // Levels
        var levelsDiv = $('#ba-bb-levels');
        for (var l = 1; l <= 7; l++) {
            (function (level) {
                var btn = $('<button>')
                    .addClass('ba-bb-btn')
                    .text(level)
                    .attr('data-level', level)
                    .on('click', function () { selectLevel(level); });
                levelsDiv.append(btn);
            })(l);
        }

        // Suits
        var suitsDiv = $('#ba-bb-suits');
        BID_SUITS.forEach(function (suit) {
            var label = suit === 'N' ? 'NT' : SUIT_SYMBOLS[suit];
            var btn = $('<button>')
                .addClass('ba-bb-btn')
                .html(label)
                .attr('data-suit', suit)
                .on('click', function () { selectSuit(suit); });
            suitsDiv.append(btn);
        });

        // Actions
        var actionsDiv = $('#ba-bb-actions');
        $('<button>').addClass('ba-bb-btn ba-bb-btn-pass').text('Pass')
            .on('click', function () { addBid('PASS'); }).appendTo(actionsDiv);
        $('<button>').addClass('ba-bb-btn ba-bb-btn-dbl').text('Dbl')
            .on('click', function () { if (canDouble()) addBid('X'); }).appendTo(actionsDiv);
        $('<button>').addClass('ba-bb-btn ba-bb-btn-rdbl').text('Rdbl')
            .on('click', function () { if (canRedouble()) addBid('XX'); }).appendTo(actionsDiv);
        $('<button>').addClass('ba-bb-btn ba-bb-btn-undo').text('Undo')
            .on('click', undoLastBid).appendTo(actionsDiv);
    }

    function selectLevel(level) {
        STATE.selectedLevel = level;
        renderBiddingBox();
    }

    function selectSuit(suit) {
        if (STATE.selectedLevel === null) return;
        var bid = STATE.selectedLevel + suit;
        if (canBid(STATE.selectedLevel, suit)) {
            addBid(bid);
        }
    }

    function renderBiddingBox() {
        var over = isAuctionOver();

        // Levels
        $('#ba-bb-levels .ba-bb-btn').each(function () {
            var level = parseInt($(this).attr('data-level'));
            $(this).toggleClass('ba-bb-active', STATE.selectedLevel === level);
            $(this).toggleClass('ba-bb-disabled', over);
        });

        // Suits
        $('#ba-bb-suits .ba-bb-btn').each(function () {
            var suit = $(this).attr('data-suit');
            var enabled = STATE.selectedLevel !== null && canBid(STATE.selectedLevel, suit) && !over;
            $(this).toggleClass('ba-bb-disabled', !enabled);
        });

        // Actions
        $('.ba-bb-btn-pass').toggleClass('ba-bb-disabled', over);
        $('.ba-bb-btn-dbl').toggleClass('ba-bb-disabled', !canDouble() || over);
        $('.ba-bb-btn-rdbl').toggleClass('ba-bb-disabled', !canRedouble() || over);
        $('.ba-bb-btn-undo').toggleClass('ba-bb-disabled', STATE.auction.length === 0);
    }

    // ===== API =====
    function buildCtxString() {
        return STATE.auction.map(function (bid) {
            if (bid === 'PASS') return '--';
            if (bid === 'X') return 'Db';
            if (bid === 'XX') return 'Rd';
            return bid;
        }).join('');
    }

    function buildAPIUrl(endpoint, extraParams) {
        var hostname = window.location.hostname || 'localhost';
        var protocol = window.location.protocol;
        var url = protocol + '//' + hostname + ':' + API_PORT + '/' + endpoint;
        if (extraParams) {
            var params = [];
            for (var k in extraParams) {
                if (extraParams[k] !== undefined && extraParams[k] !== null) {
                    params.push(encodeURIComponent(k) + '=' + encodeURIComponent(extraParams[k]));
                }
            }
            if (params.length > 0) url += '?' + params.join('&');
        }
        return url;
    }

    async function getAdvice() {
        // Validate
        if (STATE.hand.size !== 13) {
            alert('Please select exactly 13 cards for your hand.');
            return;
        }
        if (isAuctionOver()) {
            alert('The auction is already over.');
            return;
        }

        // Check it's the user's turn
        var currentSeat = getCurrentTurnSeat();
        if (currentSeat !== STATE.seat) {
            alert('It is ' + SEAT_NAMES[currentSeat] + "'s turn to bid, but your seat is " +
                SEAT_NAMES[STATE.seat] + '.\nEnter bids until it is your turn, or change your seat.');
            return;
        }

        var pbn = handToPBN();
        var ctx = buildCtxString();
        var vul = STATE.vul;
        // The API expects 'None' as empty string for no vulnerability
        if (vul === 'None') vul = '';

        showLoader();
        hideResults();

        try {
            // Call /bid with details
            var bidUrl = buildAPIUrl('bid', {
                hand: pbn,
                seat: STATE.seat,
                dealer: STATE.dealer,
                vul: vul,
                ctx: ctx,
                details: 'true'
            });

            var bidResponse = await fetch(bidUrl);
            if (!bidResponse.ok) {
                var errData = await bidResponse.json();
                throw new Error(errData.error || 'API error ' + bidResponse.status);
            }
            var bidData = await bidResponse.json();

            if (bidData.message) {
                alert(bidData.message);
                hideLoader();
                return;
            }

            // Also call /explain_auction for explanations
            var explData = null;
            try {
                var explUrl = buildAPIUrl('explain_auction', {
                    seat: STATE.seat,
                    dealer: STATE.dealer,
                    vul: vul,
                    ctx: ctx
                });
                var explResponse = await fetch(explUrl);
                if (explResponse.ok) {
                    explData = await explResponse.json();
                }
            } catch (e) {
                // Non-critical, continue without explanations
                console.warn('Could not fetch explanations:', e);
            }

            hideLoader();
            renderResults(bidData, explData);

        } catch (err) {
            hideLoader();
            alert('Error contacting BEN API:\n' + err.message +
                '\n\nMake sure gameapi.py is running on port ' + API_PORT + '.');
        }
    }

    // ===== Results Rendering =====
    function renderResults(bidData, explData) {
        $('#ba-results').show();

        // Recommendation
        renderRecommendation(bidData);

        // Candidates
        if (bidData.candidates && bidData.candidates.length > 0) {
            renderCandidates(bidData.candidates);
            $('#ba-candidates').show();
        }

        // Inference
        if (bidData.hcp && bidData.hcp !== -1) {
            renderInference(bidData.hcp, bidData.shape, bidData.quality);
            $('#ba-inference').show();
        }

        // Explanations
        if (explData && explData.explanation) {
            renderExplanations(explData);
            $('#ba-explanations').show();
        } else if (bidData.explanations && bidData.explanations.length > 0) {
            renderExplanationsFromBid(bidData.explanations);
            $('#ba-explanations').show();
        }

        // Sample-based analysis
        if (bidData.samples && bidData.samples.length > 0) {
            var parsed = parseSamples(bidData.samples, SEATS.indexOf(STATE.seat));
            var hcpStats = computeHCPStats(parsed);
            var suitStats = computeSuitStats(parsed);
            renderHCPDistribution(hcpStats);
            renderSuitDistribution(suitStats);
            renderPartnershipFit(STATE.hand, parsed);
            renderSampleHands(bidData.samples);
        }
    }

    function renderRecommendation(data) {
        var bid = data.bid;
        var bidClass = '';
        if (bid === 'PASS') bidClass = ' ba-rec-pass';
        else if (bid === 'X') bidClass = ' ba-rec-double';
        else if (bid === 'XX') bidClass = ' ba-rec-redouble';

        var bidDisplay = formatBidText(bid);
        var html = '<div>';
        html += '<span class="ba-rec-bid' + bidClass + '">' + bidDisplay + '</span>';
        html += '<span class="ba-rec-meta">';
        if (data.who) html += 'by ' + data.who;
        if (data.quality != null) html += ' &middot; quality: ' + (typeof data.quality === 'number' ? data.quality.toFixed(2) : data.quality);
        if (data.alert === 'True' || data.alert === true) html += ' &middot; <strong style="color:#c0392b">ALERT</strong>';
        html += '</span>';
        html += '</div>';

        if (data.explanation) {
            html += '<div class="ba-rec-explanation">' + formatExplanation(data.explanation) + '</div>';
        }

        $('#ba-rec-content').html(html);
    }

    function renderCandidates(candidates) {
        var html = '<table class="ba-cand-table">';
        html += '<tr><th>Bid</th><th>NN Score</th><th>Exp. Score</th><th>Exp. Tricks</th><th>Adjustment</th></tr>';
        candidates.forEach(function (c) {
            var bidStr = c.call ? formatBidText(c.call) : '';
            html += '<tr>';
            html += '<td class="ba-cand-bid">' + bidStr + '</td>';
            html += '<td>' + (c.insta_score != null ? (typeof c.insta_score === 'number' ? c.insta_score.toFixed(3) : c.insta_score) : '') + '</td>';
            html += '<td>' + formatOptionalNum(c.expected_score) + '</td>';
            html += '<td>' + formatOptionalNum(c.expected_tricks) + '</td>';
            html += '<td>' + formatOptionalNum(c.adjustment) + '</td>';
            html += '</tr>';
        });
        html += '</table>';
        $('#ba-cand-content').html(html);
    }

    function renderInference(hcp, shape, quality) {
        // hcp: [LHO, Partner, RHO] relative to seat
        // shape: flat array of 12 floats [LHO_S, LHO_H, LHO_D, LHO_C, Partner_S, ...]
        var seatIdx = SEATS.indexOf(STATE.seat);
        var labels = ['LHO', 'Partner', 'RHO'];
        var actualSeats = [
            SEATS[(seatIdx + 1) % 4],
            SEATS[(seatIdx + 2) % 4],
            SEATS[(seatIdx + 3) % 4]
        ];

        var html = '<div class="ba-inf-grid">';
        for (var p = 0; p < 3; p++) {
            html += '<div class="ba-inf-player">';
            html += '<div class="ba-inf-player-label">' + labels[p] + ' (' + actualSeats[p] + ')</div>';
            html += '<div class="ba-inf-hcp">' + (hcp[p] != null ? (typeof hcp[p] === 'number' ? hcp[p].toFixed(1) : hcp[p]) : '?') + '</div>';
            html += '<div class="ba-inf-hcp-label">HCP</div>';

            if (shape && shape.length >= (p + 1) * 4) {
                html += '<div class="ba-inf-shape">';
                for (var s = 0; s < 4; s++) {
                    var val = shape[p * 4 + s];
                    var display = (typeof val === 'number') ? val.toFixed(1) : val;
                    html += '<span class="' + SUIT_CLASSES[SUITS[s]] + '">' + SUIT_SYMBOLS[SUITS[s]] + '</span>' + display + ' ';
                }
                html += '</div>';
            }
            html += '</div>';
        }
        html += '</div>';

        if (quality != null) {
            html += '<div style="text-align:center;margin-top:8px;font-size:0.85rem;color:#888;">Sample quality: ' +
                (typeof quality === 'number' ? quality.toFixed(2) : quality) + '</div>';
        }

        $('#ba-inf-content').html(html);
    }

    function renderExplanations(explData) {
        // explData.explanation is HTML from /explain_auction
        var html = formatExplanation(explData.explanation);
        $('#ba-expl-content').html(html);
    }

    function renderExplanationsFromBid(explanations) {
        // explanations is array of [bid, explanation] tuples
        var html = '<ul class="ba-expl-list">';
        explanations.forEach(function (item) {
            var bid = item[0] || '';
            var expl = item[1] || '';
            html += '<li><span class="ba-expl-bid">' + formatBidText(bid) + '</span>: ' + formatExplanation(expl) + '</li>';
        });
        html += '</ul>';
        $('#ba-expl-content').html(html);
    }

    // ===== Formatting Helpers =====
    function formatBidText(bid) {
        if (!bid) return '';
        bid = bid.replace('PASS', 'Pass');
        if (bid === 'Pass') return 'Pass';
        if (bid === 'X') return 'Dbl';
        if (bid === 'XX') return 'Rdbl';
        if (bid.length === 2) {
            var level = bid[0];
            var suit = bid[1];
            if (BID_SUIT_DISPLAY[suit]) return level + BID_SUIT_DISPLAY[suit];
        }
        return bid;
    }

    function formatExplanation(text) {
        if (!text) return '';
        return text
            .replace(/!S/g, '<span class="ba-spades">&spades;</span>')
            .replace(/!H/g, '<span class="ba-hearts">&hearts;</span>')
            .replace(/!D/g, '<span class="ba-diamonds">&diams;</span>')
            .replace(/!C/g, '<span class="ba-clubs">&clubs;</span>');
    }

    function formatOptionalNum(val) {
        if (val == null || val === undefined) return '';
        if (typeof val === 'number') return Math.round(val * 100) / 100;
        return val;
    }

    // ===== Sample Parsing & Analysis =====
    var HCP_VALUES = { A: 4, K: 3, Q: 2, J: 1 };

    function calcHCP(pbnHand) {
        var total = 0;
        for (var i = 0; i < pbnHand.length; i++) {
            var c = pbnHand[i];
            if (HCP_VALUES[c]) total += HCP_VALUES[c];
        }
        return total;
    }

    function calcSuitLengths(pbnHand) {
        var suits = pbnHand.split('.');
        return suits.map(function (s) { return s.length; }); // [S, H, D, C]
    }

    function parseSamples(samplesArray, seatIdx) {
        // Returns { lho: {hcps, suits}, partner: {hcps, suits}, rho: {hcps, suits} }
        var lhoIdx = (seatIdx + 1) % 4;
        var partnerIdx = (seatIdx + 2) % 4;
        var rhoIdx = (seatIdx + 3) % 4;

        var result = {
            lho: { hcps: [], suits: [] },
            partner: { hcps: [], suits: [] },
            rho: { hcps: [], suits: [] }
        };

        samplesArray.forEach(function (sample) {
            // Format: "N_hand E_hand S_hand W_hand - score" or with "| ..." appended
            var mainPart = sample.split(' - ')[0].trim();
            var hands = mainPart.split(/\s+/);
            if (hands.length < 4) return;

            var mapping = [
                { key: 'lho', idx: lhoIdx },
                { key: 'partner', idx: partnerIdx },
                { key: 'rho', idx: rhoIdx }
            ];
            mapping.forEach(function (m) {
                var hand = hands[m.idx];
                if (!hand || hand.split('.').length !== 4) return;
                result[m.key].hcps.push(calcHCP(hand));
                result[m.key].suits.push(calcSuitLengths(hand));
            });
        });

        return result;
    }

    function computeHCPStats(parsed) {
        var stats = {};
        ['lho', 'partner', 'rho'].forEach(function (key) {
            var hcps = parsed[key].hcps;
            if (hcps.length === 0) { stats[key] = null; return; }
            var freq = new Array(41).fill(0);
            var sum = 0, min = 40, max = 0;
            hcps.forEach(function (h) {
                freq[h]++;
                sum += h;
                if (h < min) min = h;
                if (h > max) max = h;
            });
            var mean = sum / hcps.length;
            var mode = freq.indexOf(Math.max.apply(null, freq));
            stats[key] = { freq: freq, min: min, max: max, mean: mean, mode: mode, count: hcps.length };
        });
        return stats;
    }

    function computeSuitStats(parsed) {
        var stats = {};
        ['lho', 'partner', 'rho'].forEach(function (key) {
            var suitsData = parsed[key].suits; // array of [S,H,D,C] arrays
            if (suitsData.length === 0) { stats[key] = null; return; }
            var suitStats = [];
            for (var s = 0; s < 4; s++) {
                var freq = new Array(14).fill(0);
                var sum = 0, min = 13, max = 0;
                suitsData.forEach(function (sl) {
                    var len = sl[s];
                    freq[len]++;
                    sum += len;
                    if (len < min) min = len;
                    if (len > max) max = len;
                });
                var mean = sum / suitsData.length;
                var mode = freq.indexOf(Math.max.apply(null, freq));
                suitStats.push({ freq: freq, min: min, max: max, mean: mean, mode: mode, count: suitsData.length });
            }
            stats[key] = suitStats;
        });
        return stats;
    }

    // ===== Analysis Rendering =====
    function renderHCPDistribution(hcpStats) {
        var seatIdx = SEATS.indexOf(STATE.seat);
        var labels = ['LHO', 'Partner', 'RHO'];
        var keys = ['lho', 'partner', 'rho'];
        var colors = ['ba-hcp-color-lho', 'ba-hcp-color-partner', 'ba-hcp-color-rho'];
        var actualSeats = [
            SEATS[(seatIdx + 1) % 4],
            SEATS[(seatIdx + 2) % 4],
            SEATS[(seatIdx + 3) % 4]
        ];

        var html = '<div class="ba-hcp-players">';
        for (var p = 0; p < 3; p++) {
            var st = hcpStats[keys[p]];
            if (!st) continue;

            // Find display range (trim leading/trailing zeros)
            var lo = st.min, hi = st.max;
            lo = Math.max(0, lo - 1);
            hi = Math.min(40, hi + 1);
            var maxFreq = Math.max.apply(null, st.freq.slice(lo, hi + 1));

            html += '<div class="ba-hcp-player-row">';
            html += '<div class="ba-hcp-player-header">';
            html += '<span class="ba-hcp-player-name">' + labels[p] + ' (' + actualSeats[p] + ')</span>';
            html += '<span class="ba-hcp-player-summary">' + st.min + '&ndash;' + st.max + ' HCP, avg ' + st.mean.toFixed(1) + ', most likely ' + st.mode + '</span>';
            html += '</div>';

            // Bar chart
            html += '<div class="ba-hcp-chart">';
            for (var h = lo; h <= hi; h++) {
                var pct = maxFreq > 0 ? (st.freq[h] / maxFreq * 100) : 0;
                var freqPct = (st.freq[h] / st.count * 100).toFixed(0);
                html += '<div class="ba-hcp-bar ' + colors[p] + '" style="height:' + pct + '%" title="' + h + ' HCP: ' + freqPct + '% (' + st.freq[h] + '/' + st.count + ')"></div>';
            }
            html += '</div>';

            // Labels
            html += '<div class="ba-hcp-labels">';
            for (var h2 = lo; h2 <= hi; h2++) {
                html += '<span>' + (h2 % 2 === 0 ? h2 : '') + '</span>';
            }
            html += '</div>';
            html += '</div>';
        }
        html += '</div>';

        $('#ba-hcp-dist-content').html(html);
        $('#ba-hcp-dist').show();
    }

    function renderSuitDistribution(suitStats) {
        var seatIdx = SEATS.indexOf(STATE.seat);
        var labels = ['LHO', 'Partner', 'RHO'];
        var keys = ['lho', 'partner', 'rho'];
        var actualSeats = [
            SEATS[(seatIdx + 1) % 4],
            SEATS[(seatIdx + 2) % 4],
            SEATS[(seatIdx + 3) % 4]
        ];

        var html = '<table class="ba-dist-table">';
        html += '<tr><th></th>';
        for (var s = 0; s < 4; s++) {
            html += '<th><span class="' + SUIT_CLASSES[SUITS[s]] + '">' + SUIT_SYMBOLS[SUITS[s]] + '</span></th>';
        }
        html += '</tr>';

        for (var p = 0; p < 3; p++) {
            var ss = suitStats[keys[p]];
            if (!ss) continue;
            html += '<tr>';
            html += '<td>' + labels[p] + ' (' + actualSeats[p] + ')</td>';
            for (var s2 = 0; s2 < 4; s2++) {
                var st = ss[s2];
                var modeClass = '';
                if (st.mode === 0) modeClass = ' ba-dist-void';
                else if (st.mode >= 6) modeClass = ' ba-dist-long';

                // Build detail: top 3 most frequent lengths
                var indexed = [];
                for (var i = 0; i < st.freq.length; i++) {
                    if (st.freq[i] > 0) indexed.push({ len: i, pct: (st.freq[i] / st.count * 100) });
                }
                indexed.sort(function (a, b) { return b.pct - a.pct; });
                var detail = indexed.slice(0, 3).map(function (x) {
                    return x.len + ':' + x.pct.toFixed(0) + '%';
                }).join(' ');

                html += '<td>';
                html += '<div class="ba-dist-cell-primary' + modeClass + '">' + st.mode + '</div>';
                html += '<div class="ba-dist-cell-detail">' + detail + '</div>';
                html += '</td>';
            }
            html += '</tr>';
        }
        html += '</table>';

        $('#ba-suit-dist-content').html(html);
        $('#ba-suit-dist').show();
    }

    function renderPartnershipFit(userHand, parsed) {
        var partnerStats = computeHCPStats(parsed);
        var partnerSuits = computeSuitStats(parsed);
        var ps = partnerStats.partner;
        var pSuits = partnerSuits.partner;
        if (!ps || !pSuits) return;

        // User's HCP and suit lengths
        var userPBN = handToPBN();
        var userHCP = calcHCP(userPBN);
        var userLens = calcSuitLengths(userPBN);

        // Combined HCP
        var combinedMin = userHCP + ps.min;
        var combinedMax = userHCP + ps.max;
        var combinedAvg = userHCP + ps.mean;

        // Zone
        var zone = 'partscore', zoneLabel = 'Partscore';
        if (combinedAvg >= 33) { zone = 'grand'; zoneLabel = 'Grand Slam Zone'; }
        else if (combinedAvg >= 29) { zone = 'slam'; zoneLabel = 'Slam Zone'; }
        else if (combinedAvg >= 24) { zone = 'game'; zoneLabel = 'Game Zone'; }

        var html = '';

        // Combined HCP
        html += '<div class="ba-fit-section">';
        html += '<div class="ba-fit-label">Combined Strength</div>';
        html += '<div class="ba-fit-hcp-bar">';
        html += '<span class="ba-fit-hcp-value">' + combinedAvg.toFixed(0) + ' HCP</span>';
        html += '<span class="ba-fit-hcp-breakdown">(You: ' + userHCP + ' + Partner avg: ' + ps.mean.toFixed(1) + ', range ' + combinedMin + '&ndash;' + combinedMax + ')</span>';
        html += '</div>';
        html += '<span class="ba-zone-badge ba-zone-' + zone + '">' + zoneLabel + '</span>';
        html += '</div>';

        // Suit fit
        html += '<div class="ba-fit-section">';
        html += '<div class="ba-fit-label">Suit Fit (Your cards + Partner avg)</div>';
        html += '<div class="ba-fit-suits">';
        var bestFit = -1, bestFitSuit = -1;
        for (var s = 0; s < 4; s++) {
            var total = userLens[s] + pSuits[s].mean;
            if (total > bestFit) { bestFit = total; bestFitSuit = s; }
        }
        for (var s2 = 0; s2 < 4; s2++) {
            var total2 = userLens[s2] + pSuits[s2].mean;
            var fitClass = '';
            if (total2 >= 8) fitClass = ' ba-fit-good';
            else if (total2 >= 7) fitClass = ' ba-fit-marginal';

            html += '<div class="ba-fit-suit-card' + fitClass + '">';
            html += '<div class="ba-fit-suit-sym ' + SUIT_CLASSES[SUITS[s2]] + '">' + SUIT_SYMBOLS[SUITS[s2]] + '</div>';
            html += '<div class="ba-fit-suit-total">' + total2.toFixed(1) + '</div>';
            html += '<div class="ba-fit-suit-detail">' + userLens[s2] + ' + ' + pSuits[s2].mean.toFixed(1) + '</div>';
            html += '</div>';
        }
        html += '</div>';
        html += '</div>';

        // Best fit recommendation
        if (bestFit >= 7) {
            var suitName = SUIT_NAMES[SUITS[bestFitSuit]];
            html += '<div class="ba-fit-section">';
            html += '<div class="ba-fit-label">Best Fit</div>';
            html += '<span class="' + SUIT_CLASSES[SUITS[bestFitSuit]] + '">' + SUIT_SYMBOLS[SUITS[bestFitSuit]] + '</span> ';
            html += suitName + ' (' + bestFit.toFixed(1) + ' cards combined)';
            if (bestFit >= 8) html += ' &mdash; strong fit';
            html += '</div>';
        }

        $('#ba-fit-content').html(html);
        $('#ba-fit').show();
    }

    function renderSampleHands(samples) {
        var maxShow = 30;
        var shown = samples.slice(0, maxShow);

        var html = '<div class="ba-samples-toggle" id="ba-samples-toggle">Show ' + samples.length + ' sample hands</div>';
        html += '<div id="ba-samples-body" style="display:none">';
        html += '<table class="ba-samples-table">';
        html += '<tr><th>#</th><th>North</th><th>East</th><th>South</th><th>West</th><th>Quality</th></tr>';

        shown.forEach(function (sample, i) {
            var parts = sample.split(' - ');
            var handsPart = parts[0].trim();
            var qualPart = parts.length > 1 ? parts[1].trim().split('|')[0].trim() : '';
            var hands = handsPart.split(/\s+/);

            html += '<tr>';
            html += '<td>' + (i + 1) + '</td>';
            for (var h = 0; h < 4; h++) {
                html += '<td>' + (hands[h] || '') + '</td>';
            }
            html += '<td class="ba-sample-quality">' + (qualPart ? parseFloat(qualPart).toFixed(3) : '') + '</td>';
            html += '</tr>';
        });

        html += '</table>';
        if (samples.length > maxShow) {
            html += '<div style="font-size:0.8rem;color:#888;margin-top:4px;">Showing ' + maxShow + ' of ' + samples.length + ' samples</div>';
        }
        html += '</div>';

        $('#ba-samples-content').html(html);
        $('#ba-samples').show();

        // Toggle
        $('#ba-samples-toggle').off('click').on('click', function () {
            var body = $('#ba-samples-body');
            if (body.is(':visible')) {
                body.hide();
                $(this).text('Show ' + samples.length + ' sample hands');
            } else {
                body.show();
                $(this).text('Hide sample hands');
            }
        });
    }

    // ===== UI State Helpers =====
    function showLoader() {
        $('#ba-loader').show();
        $('#ba-get-advice').prop('disabled', true);
    }

    function hideLoader() {
        $('#ba-loader').hide();
        $('#ba-get-advice').prop('disabled', false);
    }

    function hideResults() {
        $('#ba-results').hide();
        $('#ba-candidates').hide();
        $('#ba-inference').hide();
        $('#ba-explanations').hide();
        $('#ba-hcp-dist').hide();
        $('#ba-suit-dist').hide();
        $('#ba-fit').hide();
        $('#ba-samples').hide();
    }

    function resetAll() {
        STATE.hand = new Set();
        STATE.auction = [];
        STATE.selectedLevel = null;
        syncUI();
        renderAuction();
        renderBiddingBox();
        hideResults();
        hideLoader();
    }

})();
