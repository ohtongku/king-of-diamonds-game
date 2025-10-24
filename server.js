// server.js (請完全替換舊的內容)

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const PORT = process.env.PORT || 3000;
const ROUND_DURATION = 180 * 1000; // 3 minutes in milliseconds

app.use(express.static('public'));

let gameRooms = {};

// ... connection, joinRoom, startGame, nextRound, disconnect 等函數與上一版完全相同 ...
// ... 為了避免混淆，我將貼出完整的 server.js 內容 ...

io.on('connection', (socket) => {
    console.log('一個新玩家連線了:', socket.id);

    socket.on('joinRoom', ({ roomCode, playerName }) => {
        socket.join(roomCode);
        
        if (!gameRooms[roomCode]) {
            gameRooms[roomCode] = createNewRoom(socket.id);
        }
        
        const room = gameRooms[roomCode];
        room.players[socket.id] = { 
            id: socket.id,
            name: playerName || `玩家${Object.keys(room.players).length + 1}`,
            score: 0,
            isEliminated: false
        };

        console.log(`玩家 ${room.players[socket.id].name} (${socket.id}) 加入了房間 ${roomCode}`);
        io.to(roomCode).emit('updateGameState', room);
    });

    socket.on('startGame', (roomCode) => {
        const room = gameRooms[roomCode];
        if (room && room.hostId === socket.id && room.status === 'LOBBY') {
            console.log(`房間 ${roomCode} 的主持人開始了遊戲。`);
            startNewRound(roomCode);
        }
    });

    socket.on('submitNumber', ({ roomCode, number }) => {
        const room = gameRooms[roomCode];
        if (!room || room.status !== 'PLAYING' || !room.players[socket.id]) return;

        if (room.players[socket.id].isEliminated) {
            console.log(`已淘汰的玩家 ${room.players[socket.id].name} 嘗試投票，已忽略。`);
            return;
        }

        room.currentChoices[socket.id] = number;
        io.to(roomCode).emit('playerVoted', socket.id); 

        const activePlayers = Object.values(room.players).filter(p => !p.isEliminated);
        if (Object.keys(room.currentChoices).length === activePlayers.length) {
            clearTimeout(room.roundTimer);
            processRound(roomCode);
        }
    });

    socket.on('nextRound', (roomCode) => {
        const room = gameRooms[roomCode];
        if (room && room.hostId === socket.id && room.status === 'RESULTS') {
            showScoreboard(roomCode);
        }
    });

    socket.on('disconnect', () => {
        console.log('一個玩家斷線了:', socket.id);
        for (const roomCode in gameRooms) {
            const room = gameRooms[roomCode];
            if (room.players[socket.id]) {
                const disconnectedPlayerName = room.players[socket.id].name;
                delete room.players[socket.id];
                if (room.hostId === socket.id) {
                    const newHost = Object.values(room.players)[0];
                    if (newHost) {
                        room.hostId = newHost.id;
                        console.log(`主持人斷線，新主持人是 ${newHost.name}`);
                    } else {
                        delete gameRooms[roomCode];
                        console.log(`房間 ${roomCode} 已空，被刪除。`);
                        return;
                    }
                }
                io.to(roomCode).emit('updateGameState', room);
                io.to(roomCode).emit('systemMessage', `${disconnectedPlayerName} 已離開遊戲。`);
            }
        }
    });
});

// ==========================================================
//                  核心邏輯函數 (已重構)
// ==========================================================
function processRound(roomCode) {
    const room = gameRooms[roomCode];
    if (room.status !== 'PLAYING') return;

    io.to(roomCode).emit('showAllVoted');

    const activePlayers = Object.values(room.players).filter(p => !p.isEliminated);
    const activePlayersCount = activePlayers.length;

    let choicesData = [];
    activePlayers.forEach(player => {
        const choice = (room.currentChoices[player.id] !== undefined) ? room.currentChoices[player.id] : -1; // -1 表示未投票
        choicesData.push({ playerId: player.id, choice: choice, playerName: player.name });
    });

    if (choicesData.length === 0) {
        room.status = 'LOBBY';
        io.to(roomCode).emit('updateGameState', room);
        return;
    }
    
    let winnerId = null;
    let targetNumber = 0; // 初始化
    let penalty = 1; // 預設扣分數

    // ==================【規則三: 2人對決時的特殊規則】==================
    // 優先處理此規則
    if (activePlayersCount === 2) {
        const choices = choicesData.map(c => c.choice).sort((a, b) => a - b);
        if (choices[0] === 0 && choices[1] === 100) {
            console.log(`房間 ${roomCode} 觸發了 0 vs 100 規則。`);
            winnerId = choicesData.find(c => c.choice === 100).playerId;
            // 跳過所有後續計算
        }
    }
    
    // 如果沒有觸發特殊規則，則進行正常計算
    if (winnerId === null) {
        const sum = choicesData.reduce((acc, curr) => acc + curr.choice, 0);
        const average = sum / choicesData.length;
        targetNumber = average * 0.8;
        const roundedTarget = Math.round(targetNumber);

        let winnableChoices = [];

        // ==================【規則一: 4人或以下時，同票無效】==================
        if (activePlayersCount <= 4) {
            const choiceCounts = choicesData.reduce((acc, { choice }) => {
                acc[choice] = (acc[choice] || 0) + 1;
                return acc;
            }, {});
            // 篩選出沒有重複的選擇
            winnableChoices = choicesData.filter(c => choiceCounts[c.choice] === 1);
        } else {
            // 5人或以上，所有選擇都可以獲勝
            winnableChoices = choicesData;
        }

        // 從可以獲勝的選項中，找出最接近目標的勝利者
        if (winnableChoices.length > 0) {
            let minDiff = Infinity;
            winnableChoices.forEach(({ playerId, choice }) => {
                const diff = Math.abs(choice - targetNumber);
                if (diff < minDiff) {
                    minDiff = diff;
                    winnerId = playerId;
                } else if (diff === minDiff) {
                    winnerId = null; // 如果最接近的距離有平手，則無勝利者
                }
            });
        }
        
        // ==================【規則二: 3人或以下時，精準猜中則懲罰加倍】==================
        if (activePlayersCount <= 3 && winnerId !== null) {
            const winnerChoice = choicesData.find(c => c.playerId === winnerId).choice;
            if (winnerChoice === roundedTarget) {
                console.log(`房間 ${roomCode} 觸發了精準猜中規則。`);
                penalty = 2; // 懲罰加倍
            }
        }
    }


    // ================== 分數結算與狀態更新 ==================
    const eliminatedPlayers = [];
    activePlayers.forEach(player => {
        if (player.id !== winnerId) {
            player.score -= penalty;
            if (player.score <= -10 && !player.isEliminated) {
                player.isEliminated = true;
                eliminatedPlayers.push(player.name);
            }
        }
    });

    room.lastRoundResult = {
        choices: choicesData,
        target: targetNumber.toFixed(2),
        winnerName: winnerId ? room.players[winnerId].name : '無',
        eliminatedPlayers
    };

    setTimeout(() => {
        room.status = 'RESULTS';
        io.to(roomCode).emit('updateGameState', room);
    }, 5000);
}


function createNewRoom(hostId) {
    return {
        players: {},
        status: 'LOBBY', hostId, round: 0,
        currentChoices: {}, roundTimer: null, lastRoundResult: null
    };
}

function startNewRound(roomCode) {
    const room = gameRooms[roomCode];
    room.status = 'PLAYING'; room.round++;
    room.currentChoices = {}; room.lastRoundResult = null;
    
    io.to(roomCode).emit('updateGameState', room);
    io.to(roomCode).emit('startRound', { round: room.round, duration: ROUND_DURATION });

    room.roundTimer = setTimeout(() => processRound(roomCode), ROUND_DURATION);
}

function showScoreboard(roomCode) {
    const room = gameRooms[roomCode];
    room.status = 'SCOREBOARD';
    io.to(roomCode).emit('updateGameState', room);

    setTimeout(() => {
        const remainingPlayers = Object.values(room.players).filter(p => !p.isEliminated).length;
        if (remainingPlayers <= 1) {
            room.status = 'GAME_OVER';
            io.to(roomCode).emit('updateGameState', room);
        } else {
            startNewRound(roomCode);
        }
    }, 10000);
}

server.listen(PORT, () => console.log(`伺服器正在 http://localhost:${PORT} 上運行`));
