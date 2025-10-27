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
        room.status = 'PLAYING'; room.round++;
        room.currentChoices = {}; room.lastRoundResult = null;
        
        io.to(roomCode).emit('updateGameState', getSanitizedGameState(room));
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


// ==========================================================
//                  核心邏輯函數 (再次重構)
// ==========================================================
function processRound(roomCode) {
    const room = gameRooms[roomCode];
    if (room.status !== 'PLAYING') return;
    io.to(roomCode).emit('showAllVoted');

    const activePlayers = Object.values(room.players).filter(p => !p.isEliminated);
    const activePlayersCount = activePlayers.length;
    let choicesData = activePlayers.map(p => ({
        playerId: p.id,
        playerName: p.name,
        choice: room.currentChoices[p.id] ?? -1 // -1 表示未投票
    }));

    let winnerId = null;
    let targetNumber = 0;
    let penalty = 1;
    let immunePlayerId = null; // 記錄高額豁免成功的玩家
    
    let winnerCandidates = [...choicesData]; // 初始時，所有人都有資格獲勝

    // ==================【步驟一: 處理所有特殊規則資格判定】==================

    // 【新規則: 高額豁免】(僅當人數>2時生效)
    if (activePlayersCount > 2) {
        const gambitPlayers = choicesData.filter(c => c.choice >= 75);
        if (gambitPlayers.length === 1) {
            // 情況A: 只有一人博弈成功
            immunePlayerId = gambitPlayers[0].playerId;
            console.log(`房間 ${roomCode}: 玩家 ${immunePlayerId} 豁免成功。`);
            // 這名豁免玩家不再參與勝利者競爭
            winnerCandidates = winnerCandidates.filter(p => p.playerId !== immunePlayerId);
        } else if (gambitPlayers.length > 1) {
            // 情況B: 多人博弈，他們的選擇均無效
            console.log(`房間 ${roomCode}: 多名玩家高額博弈，數字無效。`);
            const gambitPlayerIds = gambitPlayers.map(p => p.playerId);
            // 這些博弈失敗的玩家不再參與勝利者競爭
            winnerCandidates = winnerCandidates.filter(p => !gambitPlayerIds.includes(p.playerId));
        }
    }

    // 【規則三: 2人對決】(優先於常規勝負判斷)
    if (activePlayersCount === 2) {
        const choices = choicesData.map(c => c.choice).sort((a, b) => a - b);
        if (choices[0] === 0 && choices[1] === 100) {
            winnerId = choicesData.find(c => c.choice === 100).playerId;
        }
    }
    
    // ==================【步驟二: 從勝利者候選人中找出勝者】==================
    if (winnerId === null && winnerCandidates.length > 0) {
        // 【規則一: 同票無效】(僅當人數≤4時，且只在候選人中判斷)
        if (activePlayersCount <= 4) {
            const choiceCounts = winnerCandidates.reduce((acc, { choice }) => {
                acc[choice] = (acc[choice] || 0) + 1; return acc;
            }, {});
            winnerCandidates = winnerCandidates.filter(c => choiceCounts[c.choice] === 1);
        }

        // 常規勝負判斷
        if (winnerCandidates.length > 0) {
            // ** 重要: 平均數要用所有人的數字來計算 **
            const sum = choicesData.reduce((acc, curr) => acc + curr.choice, 0);
            targetNumber = (sum / choicesData.length) * 0.8;

            let minDiff = Infinity;
            winnerCandidates.forEach(({ playerId, choice }) => {
                const diff = Math.abs(choice - targetNumber);
                if (diff < minDiff) {
                    minDiff = diff;
                    winnerId = playerId;
                } else if (diff === minDiff) {
                    winnerId = null; // 距離相同則無勝利者
                }
            });

            // 【規則二: 精準命中，懲罰加倍】(僅當人數≤3時)
            if (activePlayersCount <= 3 && winnerId !== null) {
                if (choicesData.find(c => c.playerId === winnerId).choice === Math.round(targetNumber)) {
                    penalty = 2;
                }
            }
        }
    } else if (winnerCandidates.length === 0) {
        // 如果沒有勝利者候選人（例如所有人都博弈失敗了），則本回合無勝利者
        const sum = choicesData.reduce((acc, curr) => acc + curr.choice, 0);
        targetNumber = (sum / choicesData.length) * 0.8;
        winnerId = null;
    }

    // ==================【步驟三: 分數統一結算】==================
    const eliminatedPlayers = [];
    activePlayers.forEach(player => {
        // 檢查豁免資格
        if (player.id === immunePlayerId) {
            player.score += 0.5;
        } 
        // 檢查勝利資格
        else if (player.id === winnerId) {
            // 勝利者不扣分
        } 
        // 其餘均為失敗者
        else {
            player.score -= penalty;
        }
        
        // 檢查是否淘汰
        if (player.score <= -10 && !player.isEliminated) {
            player.isEliminated = true;
            eliminatedPlayers.push(player.name);
        }
    });

    room.lastRoundResult = {
        choices: choicesData, target: targetNumber.toFixed(2),
        winnerName: winnerId ? room.players[winnerId].name : '無', eliminatedPlayers
    };

    setTimeout(() => { room.status = 'RESULTS'; io.to(roomCode).emit('updateGameState', getSanitizedGameState(room)); }, 5000);
}


function showScoreboard(roomCode) {
    const room = gameRooms[roomCode]; room.status = 'SCOREBOARD';
    io.to(roomCode).emit('updateGameState', getSanitizedGameState(room));
    setTimeout(() => {
        const remaining = Object.values(room.players).filter(p => !p.isEliminated).length;
        if (remaining <= 1) {
            room.status = 'GAME_OVER';
            io.to(roomCode).emit('updateGameState', getSanitizedGameState(room));
        } else {
            startNewRound(roomCode);
        }
    }, 10000);
}

server.listen(PORT, () => console.log(`伺服器正在 http://localhost:${PORT} 上運行`));
