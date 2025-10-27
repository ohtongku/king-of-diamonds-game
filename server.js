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

function getSanitizedGameState(room) { if (!room) return null; return { players: room.players, status: room.status, hostId: room.hostId, round: room.round, lastRoundResult: room.lastRoundResult };}
io.on('connection', (socket) => { socket.on('joinRoom', ({ roomCode, playerName }) => { socket.join(roomCode); if (!gameRooms[roomCode]) { gameRooms[roomCode] = createNewRoom(socket.id); } const room = gameRooms[roomCode]; room.players[socket.id] = { id: socket.id, name: playerName || `P${Object.keys(room.players).length + 1}`, score: 0, isEliminated: false }; io.to(roomCode).emit('updateGameState', getSanitizedGameState(room)); }); socket.on('startGame', (roomCode) => { const room = gameRooms[roomCode]; if (room && room.hostId === socket.id && room.status === 'LOBBY') { startNewRound(roomCode); } }); socket.on('submitNumber', ({ roomCode, number }) => { const room = gameRooms[roomCode]; if (!room || room.status !== 'PLAYING' || !room.players[socket.id] || room.players[socket.id].isEliminated) return; room.currentChoices[socket.id] = number; io.to(roomCode).emit('playerVoted', socket.id); const activePlayers = Object.values(room.players).filter(p => !p.isEliminated); if (Object.keys(room.currentChoices).length === activePlayers.length) { clearTimeout(room.roundTimer); processRound(roomCode); } }); socket.on('nextRound', (roomCode) => { const room = gameRooms[roomCode]; if (room && room.hostId === socket.id && room.status === 'RESULTS') { showScoreboard(roomCode); } }); socket.on('disconnect', () => { for(const roomCode in gameRooms){ const room = gameRooms[roomCode]; if(room.players[socket.id]){ delete room.players[socket.id]; if(room.hostId === socket.id){ const newHost = Object.values(room.players)[0]; if(newHost) { room.hostId = newHost.id; } else { delete gameRooms[roomCode]; return; } } io.to(roomCode).emit('updateGameState', getSanitizedGameState(room)); } } });});

function createNewRoom(hostId) {
    return {
        players: {}, status: 'LOBBY', hostId, round: 0, currentChoices: {},
        roundTimer: null, lastRoundResult: null, lastRoundRules: [],
        lastWinnerId: null, // ** 新增: 追蹤上一位勝利者
        streakCount: 0      // ** 新增: 追蹤連勝次數
    };
}

function startNewRound(roomCode) {
    const room = gameRooms[roomCode];
    const activePlayersCount = Object.values(room.players).filter(p => !p.isEliminated).length;
    
    const currentRules = [];
    if (activePlayersCount === 2) {
        currentRules.push('ZERO_VS_HUNDRED');
    } else {
        // ** 核心修改：只有在沒有玩家連勝時，才啟用高額豁免規則 **
        if (activePlayersCount > 2 && room.streakCount < 2) {
            currentRules.push('HIGH_NUMBER_GAMBIT');
        }
        if (activePlayersCount <= 4) currentRules.push('TIE_INVALID');
        if (activePlayersCount <= 3) currentRules.push('DOUBLE_PENALTY');
    }
    
    const addedRules = currentRules.filter(rule => !room.lastRoundRules.includes(rule));
    room.lastRoundRules = currentRules;

    const beginRound = () => { room.status = 'PLAYING'; room.round++; room.currentChoices = {}; room.lastRoundResult = null; io.to(roomCode).emit('updateGameState', getSanitizedGameState(room)); io.to(roomCode).emit('startRound', { round: room.round, duration: ROUND_DURATION, activeRules: currentRules }); room.roundTimer = setTimeout(() => processRound(roomCode), ROUND_DURATION); };
    if (addedRules.length > 0) { io.to(roomCode).emit('newRulesAdded', addedRules); setTimeout(beginRound, NEW_RULE_DELAY); } else { beginRound(); }
}

function processRound(roomCode) {
    const room = gameRooms[roomCode];
    if (room.status !== 'PLAYING') return;
    io.to(roomCode).emit('showAllVoted');

    const activePlayers = Object.values(room.players).filter(p => !p.isEliminated);
    const activePlayersCount = activePlayers.length;
    let choicesData = activePlayers.map(p => ({ playerId: p.id, playerName: p.name, choice: room.currentChoices[p.id] ?? -1 }));
    
    let winnerId = null; let targetNumber = 0; let penalty = 1; let immunePlayerId = null;
    
    if (activePlayersCount === 2) {
        // ... 兩人對決邏輯不變 ...
        const [playerA, playerB] = choicesData; const choiceA = playerA.choice; const choiceB = playerB.choice;
        if ((choiceA === 0 && choiceB === 100) || (choiceA === 100 && choiceB === 0)) { winnerId = choiceA === 100 ? playerA.playerId : playerB.playerId; } else { targetNumber = (choiceA + choiceB) * 0.8 / 2; const diffA = Math.abs(choiceA - targetNumber); const diffB = Math.abs(choiceB - targetNumber); if (diffA < diffB) { winnerId = playerA.playerId; } else if (diffB < diffA) { winnerId = playerB.playerId; } else { winnerId = null; } }
    } else {
        // ========== 三人或以上模式邏輯 ==========
        const disqualifiedPlayerIds = new Set();
        // ** 核心修改：豁免規則現在也受連勝狀態影響 **
        if (activePlayersCount > 2 && room.streakCount < 2) {
            const gambitPlayers = choicesData.filter(c => c.choice >= 75);
            if (gambitPlayers.length === 1) { immunePlayerId = gambitPlayers[0].playerId; }
            else if (gambitPlayers.length > 1) { gambitPlayers.forEach(p => disqualifiedPlayerIds.add(p.playerId)); }
        }
        if (activePlayersCount <= 4) { const choiceCounts = choicesData.reduce((acc, { choice }) => { if (choice !== -1) acc[choice] = (acc[choice] || 0) + 1; return acc; }, {}); choicesData.forEach(p => { if (choiceCounts[p.choice] > 1) { disqualifiedPlayerIds.add(p.playerId); } }); }
        
        let winnerCandidates = choicesData.filter(p => !disqualifiedPlayerIds.has(p.playerId) && p.playerId !== immunePlayerId);
        if (winnerCandidates.length > 0) {
            const sum = choicesData.reduce((acc, curr) => acc + (curr.choice > -1 ? curr.choice : 0), 0);
            targetNumber = (sum / choicesData.length) * 0.8;
            let minDiff = Infinity;
            winnerCandidates.forEach(({ playerId, choice }) => { const diff = Math.abs(choice - targetNumber); if (diff < minDiff) { minDiff = diff; winnerId = playerId; } else if (diff === minDiff) { winnerId = null; } });
            if (activePlayersCount <= 3 && winnerId !== null) { if (choicesData.find(c => c.playerId === winnerId).choice === Math.round(targetNumber)) { penalty = 2; } }
        } else {
            const sum = choicesData.reduce((acc, curr) => acc + (curr.choice > -1 ? curr.choice : 0), 0);
            targetNumber = (sum / choicesData.length) * 0.8; winnerId = null;
        }
    }

    // ** 核心修改：更新連勝計數器 **
    if (winnerId && winnerId === room.lastWinnerId) {
        room.streakCount++;
        console.log(`玩家 ${winnerId} 連勝次數: ${room.streakCount}`);
    } else {
        // 如果勝利者換人或無勝利者，重置計數器
        room.streakCount = winnerId ? 1 : 0;
    }
    room.lastWinnerId = winnerId; // 記錄本次勝利者
    
    // ** 核心修改：統一分數結算，移除 +0.5 **
    const eliminatedPlayers = [];
    activePlayers.forEach(player => {
        if (player.id === immunePlayerId || player.id === winnerId) {
            // 豁免者或勝利者，分數不變
        } else {
            player.score -= penalty;
        }
        if (player.score <= -10 && !player.isEliminated) {
            player.isEliminated = true; eliminatedPlayers.push(player.name);
        }
    });

    room.lastRoundResult = { choices: choicesData, target: targetNumber.toFixed(2), winnerName: winnerId ? room.players[winnerId].name : '無', eliminatedPlayers };
    setTimeout(() => { room.status = 'RESULTS'; io.to(roomCode).emit('updateGameState', getSanitizedGameState(room)); }, 5000);
}

function showScoreboard(roomCode) {
    const room = gameRooms[roomCode]; room.status = 'SCOREBOARD';
    io.to(roomCode).emit('updateGameState', getSanitizedGameState(room));
    setTimeout(() => {
        const remaining = Object.values(room.players).filter(p => !p.isEliminated).length;
        if (remaining <= 1) {
            room.status = 'GAME_OVER'; io.to(roomCode).emit('updateGameState', getSanitizedGameState(room));
        } else {
            startNewRound(roomCode);
        }
    }, 10000);
}

server.listen(PORT, () => console.log(`伺服器正在 http://localhost:${PORT} 上運行`));
