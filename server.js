// server.js (請完整替換舊的內容)

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const PORT = process.env.PORT || 3000;
const ROUND_DURATION = 180 * 1000;
const NEW_RULE_DELAY = 5000;

app.use(express.static('public'));

let gameRooms = {};

// ** 核心修正：建立一個淨化函數，只挑選安全的數據發送給前端 **
function getSanitizedGameState(room) {
    if (!room) return null;
    return {
        players: room.players,
        status: room.status,
        hostId: room.hostId,
        round: room.round,
        lastRoundResult: room.lastRoundResult
        // ** 我們故意移除了 roundTimer 和 lastRoundRules **
    };
}

io.on('connection', (socket) => {
    socket.on('joinRoom', ({ roomCode, playerName }) => {
        socket.join(roomCode);
        if (!gameRooms[roomCode]) { gameRooms[roomCode] = createNewRoom(socket.id); }
        const room = gameRooms[roomCode];
        room.players[socket.id] = { id: socket.id, name: playerName || `P${Object.keys(room.players).length + 1}`, score: 0, isEliminated: false };
        io.to(roomCode).emit('updateGameState', getSanitizedGameState(room)); // ** UPDATE **
    });

    socket.on('startGame', (roomCode) => {
        const room = gameRooms[roomCode];
        if (room && room.hostId === socket.id && room.status === 'LOBBY') {
            startNewRound(roomCode);
        }
    });
    
    // ... submitNumber, nextRound and disconnect logic are fine, but disconnect also emits game state
    socket.on('submitNumber', ({ roomCode, number }) => { const room = gameRooms[roomCode]; if (!room || room.status !== 'PLAYING' || !room.players[socket.id] || room.players[socket.id].isEliminated) return; room.currentChoices[socket.id] = number; io.to(roomCode).emit('playerVoted', socket.id); const activePlayers = Object.values(room.players).filter(p => !p.isEliminated); if (Object.keys(room.currentChoices).length === activePlayers.length) { clearTimeout(room.roundTimer); processRound(roomCode); } });
    socket.on('nextRound', (roomCode) => { const room = gameRooms[roomCode]; if (room && room.hostId === socket.id && room.status === 'RESULTS') { showScoreboard(roomCode); } });
    socket.on('disconnect', () => { 
        for(const roomCode in gameRooms){
            const room = gameRooms[roomCode];
            if(room.players[socket.id]){
                delete room.players[socket.id];
                if(room.hostId === socket.id){
                    const newHost = Object.values(room.players)[0];
                    if(newHost) { room.hostId = newHost.id; }
                    else { delete gameRooms[roomCode]; return; }
                }
                io.to(roomCode).emit('updateGameState', getSanitizedGameState(room)); // ** UPDATE **
            }
        }
    });
});

// The rest of the functions are mostly the same, but they emit the sanitized state
function createNewRoom(hostId) { return { players: {}, status: 'LOBBY', hostId, round: 0, currentChoices: {}, roundTimer: null, lastRoundResult: null, lastRoundRules: [] }; }

function startNewRound(roomCode) {
    const room = gameRooms[roomCode];
    const activePlayersCount = Object.values(room.players).filter(p => !p.isEliminated).length;
    const currentRules = [];
    if (activePlayersCount > 2) currentRules.push('HIGH_NUMBER_GAMBIT');
    if (activePlayersCount <= 4) currentRules.push('TIE_INVALID');
    if (activePlayersCount <= 3) currentRules.push('DOUBLE_PENALTY');
    if (activePlayersCount <= 2) currentRules.push('ZERO_VS_HUNDRED');
    const addedRules = currentRules.filter(rule => !room.lastRoundRules.includes(rule));
    room.lastRoundRules = currentRules;

    const beginRound = () => {
        room.status = 'PLAYING'; room.round++; room.currentChoices = {}; room.lastRoundResult = null;
        io.to(roomCode).emit('updateGameState', getSanitizedGameState(room)); // ** UPDATE **
        io.to(roomCode).emit('startRound', { round: room.round, duration: ROUND_DURATION, activeRules: currentRules });
        room.roundTimer = setTimeout(() => processRound(roomCode), ROUND_DURATION);
    };

    if (addedRules.length > 0) {
        io.to(roomCode).emit('newRulesAdded', addedRules);
        setTimeout(beginRound, NEW_RULE_DELAY);
    } else {
        beginRound();
    }
}

function processRound(roomCode) {
    const room = gameRooms[roomCode];
    if (room.status !== 'PLAYING') return;
    io.to(roomCode).emit('showAllVoted');
    
    // The internal logic of processRound is correct and doesn't need changes.
    // ... same as last version ...
    const activePlayers = Object.values(room.players).filter(p => !p.isEliminated);
    const activePlayersCount = activePlayers.length;
    let choicesData = activePlayers.map(p => ({ playerId: p.id, playerName: p.name, choice: room.currentChoices[p.id] ?? -1 }));
    let winnerId = null, targetNumber = 0, penalty = 1, safePlayerId = null;
    if (activePlayersCount > 2) { const gambitPlayers = choicesData.filter(c => c.choice >= 75); if (gambitPlayers.length === 1) { safePlayerId = gambitPlayers[0].playerId; } }
    if (activePlayersCount === 2) { const choices = choicesData.map(c => c.choice).sort((a, b) => a - b); if (choices[0] === 0 && choices[1] === 100) { winnerId = choicesData.find(c => c.choice === 100).playerId; } }
    if (winnerId === null) { const sum = choicesData.reduce((acc, curr) => acc + curr.choice, 0); targetNumber = sum / choicesData.length * 0.8; let winnerCandidates = choicesData.filter(p => p.playerId !== safePlayerId); if (activePlayersCount <= 4) { const choiceCounts = winnerCandidates.reduce((acc, { choice }) => { acc[choice] = (acc[choice] || 0) + 1; return acc; }, {}); winnerCandidates = winnerCandidates.filter(c => choiceCounts[c.choice] === 1); } if (winnerCandidates.length > 0) { let minDiff = Infinity; winnerCandidates.forEach(({ playerId, choice }) => { const diff = Math.abs(choice - targetNumber); if (diff < minDiff) { minDiff = diff; winnerId = playerId; } else if (diff === minDiff) { winnerId = null; } }); } if (activePlayersCount <= 3 && winnerId !== null) { if (choicesData.find(c => c.playerId === winnerId).choice === Math.round(targetNumber)) { penalty = 2; } } }
    const eliminatedPlayers = [];
    activePlayers.forEach(player => { if (player.id === safePlayerId) { player.score += 0.5; } else if (player.id !== winnerId) { player.score -= penalty; } if (player.score <= -10 && !player.isEliminated) { player.isEliminated = true; eliminatedPlayers.push(player.name); } });
    room.lastRoundResult = { choices: choicesData, target: targetNumber.toFixed(2), winnerName: winnerId ? room.players[winnerId].name : '無', eliminatedPlayers };
    
    setTimeout(() => {
        room.status = 'RESULTS';
        io.to(roomCode).emit('updateGameState', getSanitizedGameState(room)); // ** UPDATE **
    }, 5000);
}

function showScoreboard(roomCode) {
    const room = gameRooms[roomCode];
    room.status = 'SCOREBOARD';
    io.to(roomCode).emit('updateGameState', getSanitizedGameState(room)); // ** UPDATE **

    setTimeout(() => {
        const remaining = Object.values(room.players).filter(p => !p.isEliminated).length;
        if (remaining <= 1) {
            room.status = 'GAME_OVER';
        } else {
            // We don't call startNewRound directly. Instead, we change the status,
            // and the host will see the button to start the next round or it starts automatically
            // Our current logic automatically starts it, so this is fine.
            startNewRound(roomCode);
            return; // Important to return here to avoid emitting game state twice
        }
        io.to(roomCode).emit('updateGameState', getSanitizedGameState(room)); // ** UPDATE **
    }, 10000);
}

server.listen(PORT, () => console.log(`伺服器正在 http://localhost:${PORT} 上運行`));
