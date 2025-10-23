// server.js

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
        if (room && room.status === 'PLAYING' && room.players[socket.id]) {
            room.currentChoices[socket.id] = number;
            io.to(roomCode).emit('playerVoted', socket.id); // 通知前端有玩家已投票

            const activePlayers = Object.values(room.players).filter(p => !p.isEliminated);
            if (Object.keys(room.currentChoices).length === activePlayers.length) {
                // 所有人都投票了，提前結束
                clearTimeout(room.roundTimer);
                processRound(roomCode);
            }
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
                
                // 如果主持人斷線，指派新主持人
                if (room.hostId === socket.id) {
                    const newHost = Object.values(room.players)[0];
                    if (newHost) {
                        room.hostId = newHost.id;
                        console.log(`主持人斷線，新主持人是 ${newHost.name}`);
                    } else {
                        // 房間空了，刪除房間
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

function createNewRoom(hostId) {
    return {
        players: {},
        status: 'LOBBY', // LOBBY, PLAYING, RESULTS, SCOREBOARD
        hostId: hostId,
        round: 0,
        currentChoices: {},
        roundTimer: null,
        lastRoundResult: null
    };
}

function startNewRound(roomCode) {
    const room = gameRooms[roomCode];
    room.status = 'PLAYING';
    room.round++;
    room.currentChoices = {};
    room.lastRoundResult = null;
    
    io.to(roomCode).emit('updateGameState', room);
    io.to(roomCode).emit('startRound', { round: room.round, duration: ROUND_DURATION });

    room.roundTimer = setTimeout(() => {
        processRound(roomCode);
    }, ROUND_DURATION);
}

function processRound(roomCode) {
    const room = gameRooms[roomCode];
    if (room.status !== 'PLAYING') return;

    io.to(roomCode).emit('showAllVoted'); // 通知客戶端顯示「所有玩家已投票」

    const choicesData = [];
    const activePlayers = Object.values(room.players).filter(p => !p.isEliminated);
    
    activePlayers.forEach(player => {
        // 如果玩家在時間內未投票，給予一個隨機數或特定懲罰
        const choice = (room.currentChoices[player.id] !== undefined) ? room.currentChoices[player.id] : Math.floor(Math.random() * 101);
        choicesData.push({ playerId: player.id, choice: choice, playerName: player.name });
    });
    
    if (choicesData.length === 0) {
        room.status = 'LOBBY'; // 沒有活躍玩家，返回大廳
        io.to(roomCode).emit('updateGameState', room);
        return;
    }

    const sum = choicesData.reduce((acc, curr) => acc + curr.choice, 0);
    const average = sum / choicesData.length;
    const targetNumber = average * 0.8;

    // ... (計算勝利者邏輯與之前版本相同) ...
    const choiceCounts = choicesData.reduce((acc, { choice }) => {
        acc[choice] = (acc[choice] || 0) + 1; return acc;
    }, {});
    
    let winnerId = null;
    let minDiff = Infinity;
    choicesData.forEach(({ playerId, choice }) => {
        if (choiceCounts[choice] > 1) return;
        const diff = Math.abs(choice - targetNumber);
        if (diff < minDiff) {
            minDiff = diff;
            winnerId = playerId;
        } else if (diff === minDiff) {
            winnerId = null;
        }
    });

    const eliminatedPlayers = [];
    activePlayers.forEach(player => {
        if (player.id !== winnerId) {
            player.score--;
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
    }, 5000); // 5秒後切換到結果畫面
}

function showScoreboard(roomCode) {
    const room = gameRooms[roomCode];
    room.status = 'SCOREBOARD';
    io.to(roomCode).emit('updateGameState', room);

    // 10秒後自動開始下一輪
    setTimeout(() => {
        const remainingPlayers = Object.values(room.players).filter(p => !p.isEliminated).length;
        if (remainingPlayers <= 1) {
            // 遊戲結束
            room.status = 'GAME_OVER';
            io.to(roomCode).emit('updateGameState', room);
        } else {
            startNewRound(roomCode);
        }
    }, 10000);
}


server.listen(PORT, () => console.log(`伺服器正在 http://localhost:${PORT} 上運行`));
