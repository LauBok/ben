// BEN Multiplayer Lobby — mode-aware create/join

(function () {
    'use strict';

    var SEATS = ['N', 'E', 'S', 'W'];
    var API_PORT = 8080;
    var MODE_LABELS = {
        casual: 'Casual Play',
        dual: 'Dual Table',
        match2v2: 'Match 2v2',
        match4v4: 'Match 4v4'
    };

    var _isRemote = location.hostname !== 'localhost' && location.hostname !== '127.0.0.1';
    function apiBase() {
        if (_isRemote) return location.protocol + '//' + location.host;
        return location.protocol + '//' + location.hostname + ':' + API_PORT;
    }

    var state = {
        playerName: localStorage.getItem('ben_player_name') || '',
        currentRoom: null,
        mySeat: null,
        myTable: 1,
        isHost: false,
        pollTimer: null
    };

    function $(sel) { return document.querySelector(sel); }

    function getPlayerName() {
        var name = $('#lobby-player-name').value.trim();
        if (!name) {
            name = 'Player_' + Math.random().toString(36).slice(2, 6);
            $('#lobby-player-name').value = name;
        }
        localStorage.setItem('ben_player_name', name);
        return name;
    }

    function api(method, path, body) {
        var opts = { method: method, headers: { 'Content-Type': 'application/json' } };
        if (body) opts.body = JSON.stringify(body);
        return fetch(apiBase() + path, opts).then(function (r) {
            if (!r.ok) return r.text().then(function (t) { throw new Error(t); });
            return r.json();
        });
    }

    // === Mode UI ===

    function onModeChange() {
        var mode = $('#lobby-mode').value;
        var isMatch = mode === 'match2v2' || mode === 'match4v4';
        $('#lobby-rounds-row').style.display = isMatch ? '' : 'none';
        // In match2v2, only N/S seats allowed
        var seatRadios = document.querySelectorAll('input[name="lobby-host-seat"]');
        seatRadios.forEach(function(r) {
            var disabled = mode === 'match2v2' && (r.value === 'E' || r.value === 'W');
            r.disabled = disabled;
            if (disabled && r.checked) {
                // Switch to S if current selection is disabled
                document.querySelector('input[name="lobby-host-seat"][value="S"]').checked = true;
            }
        });
    }

    // === Create Game ===

    function createGame() {
        var name = getPlayerName();
        var seat = document.querySelector('input[name="lobby-host-seat"]:checked').value;
        var server = $('#lobby-create-server').value;
        var mode = $('#lobby-mode').value;
        var numRounds = (mode === 'match2v2' || mode === 'match4v4')
            ? parseInt($('#lobby-rounds').value) : 0;

        api('POST', '/api/rooms', {
            name: name + "'s game",
            host: name,
            seat: seat,
            server: server,
            mode: mode,
            num_rounds: numRounds,
            table: 1
        }).then(function (room) {
            state.currentRoom = room;
            state.mySeat = seat;
            state.myTable = 1;
            state.isHost = true;
            showRoom(room);
        }).catch(function (e) {
            alert('Error: ' + e.message);
        });
    }

    // === Join Game ===

    function joinGame() {
        var code = $('#lobby-join-code').value.trim().toUpperCase();
        if (!code) { alert('Enter a game code'); return; }

        api('GET', '/api/rooms/' + code).then(function (room) {
            state.currentRoom = room;
            state.isHost = false;
            // Check if we're already seated
            var name = getPlayerName();
            for (var t = 1; t <= 2; t++) {
                var seatsKey = t === 1 ? 'seats' : 'table2_seats';
                for (var s = 0; s < 4; s++) {
                    if (room[seatsKey][SEATS[s]] === name) {
                        state.mySeat = SEATS[s];
                        state.myTable = t;
                        break;
                    }
                }
                if (state.mySeat) break;
            }
            showRoom(room);
        }).catch(function () {
            alert('Game not found. Check the code and try again.');
        });
    }

    function joinSeat(roomId, seat, table) {
        var name = getPlayerName();
        api('POST', '/api/rooms/' + roomId + '/join', {
            name: name,
            seat: seat,
            table: table
        }).then(function (room) {
            state.currentRoom = room;
            state.mySeat = seat;
            state.myTable = table;
            showRoom(room);
        }).catch(function (e) {
            alert('Cannot join: ' + e.message);
        });
    }

    // === Room Display ===

    function showRoom(room) {
        $('#lobby-setup').style.display = 'none';
        $('#lobby-room').style.display = '';
        $('#lobby-code-display').textContent = room.id;

        var mode = room.mode || 'casual';
        var isMatch = mode === 'match2v2' || mode === 'match4v4';
        var label = $('#lobby-mode-label');
        label.textContent = MODE_LABELS[mode] || mode;
        label.className = 'lobby-mode-badge mode-' + mode;

        // Show/hide table 2
        var showTable2 = isMatch;
        $('#lobby-table2-section').style.display = showTable2 ? '' : 'none';
        $('#lobby-table1-label').style.display = showTable2 ? '' : 'none';

        var name = getPlayerName();
        var isHost = (room.host === name);

        // Render table 1 seats
        renderTableSeats(room, 'seats', '', 1, name, mode);

        // Render table 2 seats (match modes)
        if (showTable2) {
            renderTableSeats(room, 'table2_seats', '2', 2, name, mode);
        }

        // Status
        var t1_humans = SEATS.filter(function (s) { return room.seats[s] !== null; });
        var t2_humans = SEATS.filter(function (s) { return room.table2_seats[s] !== null; });
        var statusEl = $('#lobby-status');

        if (room.state === 'starting') {
            statusEl.textContent = 'Game starting...';
            startGameRedirect(room);
            return;
        }

        var statusText = '';
        if (isMatch) {
            statusText = 'Table 1: ' + t1_humans.length + ' players. Table 2: ' + t2_humans.length + ' players. ';
        } else {
            statusText = t1_humans.length + ' player(s) seated. ';
        }
        statusText += isHost ? 'Click Start when ready.' : 'Waiting for host to start.';
        statusEl.textContent = statusText;

        // Start button
        var startBtn = $('#lobby-start-btn');
        var canStart = false;
        if (isHost && state.mySeat) {
            if (mode === 'casual' || mode === 'dual') {
                canStart = t1_humans.length >= 1;
            } else if (mode === 'match2v2') {
                canStart = t1_humans.length >= 2 && t2_humans.length >= 2;
            } else if (mode === 'match4v4') {
                canStart = t1_humans.length >= 4 && t2_humans.length >= 4;
            }
        }
        startBtn.style.display = canStart ? '' : 'none';
        $('#lobby-leave-btn').style.display = state.mySeat ? '' : 'none';

        startPolling(room.id);
    }

    function renderTableSeats(room, seatsKey, idSuffix, tableNum, name, mode) {
        var isMatch2v2 = mode === 'match2v2';
        var isMatch4v4 = mode === 'match4v4';
        var isMatch = isMatch2v2 || isMatch4v4;
        for (var s = 0; s < 4; s++) {
            var seat = SEATS[s];
            var el = $('#lobby-seat' + idSuffix + '-' + seat + ' .lobby-seat-player');
            if (!el) continue;
            var player = room[seatsKey][seat];

            // In match2v2, E+W are always AI
            var isAISeat = isMatch2v2 && (seat === 'E' || seat === 'W');

            // Team labels for 4v4: Table 1 NS & Table 2 EW = Team A, rest = Team B
            var teamLabel = '';
            if (isMatch4v4) {
                var isTeamA = (tableNum === 1 && (seat === 'N' || seat === 'S'))
                    || (tableNum === 2 && (seat === 'E' || seat === 'W'));
                teamLabel = isTeamA ? ' [A]' : ' [B]';
            }

            var labelEl = $('#lobby-seat' + idSuffix + '-' + seat + ' .lobby-seat-label');
            if (labelEl) {
                var seatNames = { N: 'North', E: 'East', S: 'South', W: 'West' };
                labelEl.textContent = seatNames[seat] + teamLabel;
            }

            if (player === name && seat === state.mySeat && tableNum === state.myTable) {
                el.textContent = player + ' (you)';
                el.className = 'lobby-seat-player you';
                el.onclick = null;
                el.style.cursor = '';
            } else if (player) {
                el.textContent = player;
                el.className = 'lobby-seat-player occupied';
                el.onclick = null;
                el.style.cursor = '';
            } else if (isAISeat) {
                el.textContent = 'AI';
                el.className = 'lobby-seat-player ai';
                el.onclick = null;
                el.style.cursor = '';
            } else if (state.mySeat && !isMatch) {
                // Non-match modes: unfilled seats are AI
                el.textContent = 'AI';
                el.className = 'lobby-seat-player ai';
                el.onclick = null;
                el.style.cursor = '';
            } else if (!state.mySeat || isMatch) {
                // Not seated yet, or match mode (need more humans)
                el.textContent = 'Sit here';
                el.className = 'lobby-seat-player open';
                el.style.cursor = 'pointer';
                (function (s2, t) {
                    el.onclick = function () { joinSeat(room.id, s2, t); };
                })(seat, tableNum);
            }
        }
    }

    // === Polling ===

    function startPolling(roomId) {
        stopPolling();
        state.pollTimer = setInterval(function () {
            api('GET', '/api/rooms/' + roomId).then(function (room) {
                state.currentRoom = room;
                showRoom(room);
            }).catch(function () {
                stopPolling();
                $('#lobby-status').textContent = 'Room was closed.';
            });
        }, 2000);
    }

    function stopPolling() {
        if (state.pollTimer) {
            clearInterval(state.pollTimer);
            state.pollTimer = null;
        }
    }

    // === Start / Leave ===

    function startGame() {
        if (!state.currentRoom) return;
        api('POST', '/api/rooms/' + state.currentRoom.id + '/start').then(function (room) {
            state.currentRoom = room;
            startGameRedirect(room);
        }).catch(function (e) {
            alert('Cannot start: ' + e.message);
        });
    }

    function startGameRedirect(room) {
        stopPolling();
        var mode = room.mode || 'casual';
        var isMatch = mode === 'match2v2' || mode === 'match4v4';
        var myTable = state.myTable || 1;

        // Build human seats string for my table
        var seatsKey = myTable === 2 ? 'table2_seats' : 'seats';
        var humanSeats = SEATS.filter(function (s) { return room[seatsKey][s] !== null; });

        var params = [
            'room=' + room.id,
            'seat=' + state.mySeat,
            'human_seats=' + humanSeats.join(''),
            'board_seed=' + room.board_seed,
            'server=' + room.server,
            'mode=' + mode,
            'num_rounds=' + (room.num_rounds || 0),
            'table=' + myTable
        ];
        window.location.href = 'play.html?' + params.join('&');
    }

    function leaveRoom() {
        if (!state.currentRoom || !state.mySeat) return;
        stopPolling();
        api('POST', '/api/rooms/' + state.currentRoom.id + '/leave', {
            seat: state.mySeat,
            table: state.myTable
        }).finally(function () {
            state.currentRoom = null;
            state.mySeat = null;
            state.myTable = 1;
            state.isHost = false;
            $('#lobby-room').style.display = 'none';
            $('#lobby-setup').style.display = '';
        });
    }

    // === Copy Code ===

    function copyCode() {
        var code = $('#lobby-code-display').textContent;
        if (navigator.clipboard) {
            navigator.clipboard.writeText(code).then(function () {
                var btn = $('#lobby-copy-btn');
                btn.textContent = 'Copied!';
                setTimeout(function () { btn.textContent = 'Copy'; }, 1500);
            });
        } else {
            var ta = document.createElement('textarea');
            ta.value = code;
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
            var btn = $('#lobby-copy-btn');
            btn.textContent = 'Copied!';
            setTimeout(function () { btn.textContent = 'Copy'; }, 1500);
        }
    }

    // === Init ===

    document.addEventListener('DOMContentLoaded', function () {
        if (state.playerName) {
            $('#lobby-player-name').value = state.playerName;
        }

        $('#lobby-player-name').addEventListener('change', function () {
            state.playerName = this.value.trim();
            localStorage.setItem('ben_player_name', state.playerName);
        });

        $('#lobby-mode').addEventListener('change', onModeChange);
        $('#lobby-create-btn').addEventListener('click', createGame);
        $('#lobby-join-btn').addEventListener('click', joinGame);
        $('#lobby-start-btn').addEventListener('click', startGame);
        $('#lobby-leave-btn').addEventListener('click', leaveRoom);
        $('#lobby-copy-btn').addEventListener('click', copyCode);

        $('#lobby-join-code').addEventListener('keydown', function (e) {
            if (e.key === 'Enter') joinGame();
        });

        onModeChange();
    });

})();
