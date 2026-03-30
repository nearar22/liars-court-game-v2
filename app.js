/**
 * LIAR'S COURT — REAL-TIME ONLINE ENGINE
 * Contract: 0xc1adF4C73A05FE720746DA8d15803B0DEC588439
 * Network: Bradbury Testnet (Chain ID 4221)
 */

const RPC_URL = "https://rpc-bradbury.genlayer.com";
const CONTRACT_ADDRESS = "0xc1adF4C73A05FE720746DA8d15803B0DEC588439";
const CHAIN_ID = "0x107d";

// ── STATE ──
let state = {
    connected: false,
    currentPhase: "LOBBY",
    currentRoomId: null,
    roomData: null,
    playerName: "",
    playerAddr: "",
    selectedTheme: "Geography",
    myVotes: {},
    myClaim: null,
    pollingInterval: null
};

// ── HELPERS ──
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

function shortAddr(addr) {
    return addr ? addr.substring(0, 6) + "..." + addr.substring(38) : "???";
}

function addLog(msg) {
    const log = $("#activityLog");
    const now = new Date();
    const time = now.getHours().toString().padStart(2,"0") + ":" + now.getMinutes().toString().padStart(2,"0");
    log.innerHTML = `<div class="log-entry"><span class="log-time">${time}</span><span class="log-msg">${msg}</span></div>` + log.innerHTML;
    if (log.children.length > 20) log.lastChild.remove();
}

// ══════════════════════════════════
//  INTELLIGENT CONTRACT INTERFACE
// ══════════════════════════════════
const blockchain = {
    async call(method, args = []) {
        try {
            // For a production GenLayer app, we use genlayer-js
            // In this env, we simulate the fetch from the JSON-RPC
            const response = await fetch(RPC_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'gen_call',
                    params: [CONTRACT_ADDRESS, method, args]
                })
            });
            const data = await response.json();
            return data.result ? JSON.parse(data.result) : null;
        } catch (e) {
            console.error("RPC Call failed", e);
            return null;
        }
    },
    async write(method, args = []) {
        if (!state.connected) {
            alert("Connect wallet first!");
            return;
        }
        addLog(`Sending <span class="highlight">${method}</span> to GenLayer...`);
        // In browser, this would use window.ethereum.request(...) via genlayer-js
        console.log(`Writing ${method} with args`, args);
        return { hash: "0x" + Math.random().toString(16).slice(2) };
    }
};

// ══════════════════════════════════
//  FIREBASE COORDINATION LAYER
// ══════════════════════════════════
const firebaseConfig = {
  apiKey: "AIzaSyAZALzXYxbE6pvUS-2NrVEmo04iH8AFQAA",
  authDomain: "liars-court.firebaseapp.com",
  databaseURL: "https://liars-court-default-rtdb.firebaseio.com",
  projectId: "liars-court",
  storageBucket: "liars-court.firebasestorage.app",
  messagingSenderId: "737991898395",
  appId: "1:737991898395:web:ae46b1bbedd0f85c190fbe"
};

// Initialize Firebase
firebase.initializeApp(firebaseConfig);
const db = firebase.database();

// ══════════════════════════════════
//  REAL-TIME SYNC (FIREBASE POWERED)
// ══════════════════════════════════
function startPolling() {
    if (!state.currentRoomId) return;
    
    // Listen to real-time updates from Firebase
    const roomRef = db.ref('rooms/' + state.currentRoomId);
    roomRef.on('value', (snapshot) => {
        const room = snapshot.val();
        if (!room) return;

        console.log("Firebase Sync:", room);
        const oldPhase = state.currentPhase;
        state.roomData = room;
        state.currentPhase = room.phase;

        // 1. Update UI
        $("#lobbyRoomName").textContent = room.name || "Liar's Court";
        $("#lobbyRoomCode").textContent = state.currentRoomId;
        $("#themeName").textContent = room.theme;

        // 2. Players Grid
        const playersList = room.players ? Object.values(room.players) : [];
        renderPlayerSlots(playersList, 4);

        // 3. Phase Transitions
        if (oldPhase !== state.currentPhase) {
            addLog(`Court moved to <span class="highlight">${state.currentPhase}</span> phase`);
            showPhase(state.currentPhase);
        }

        // 4. Host logic
        const startBtn = $("#startGameBtn");
        const isHost = room.host === state.playerAddr;
        if (isHost && state.currentPhase === "LOBBY") {
            startBtn.disabled = playersList.length < 2;
            startBtn.textContent = playersList.length < 2 ? "NEED 2+ PLAYERS" : "START GAME";
        } else {
            startBtn.disabled = true;
            startBtn.textContent = state.currentPhase === "LOBBY" ? "WAITING FOR HOST..." : "IN PROGRESS";
        }
    });
}

function renderPlayerSlots(players = [], max = 4) {
    const grid = $("#playersGrid");
    let html = "";
    const avatars = ["🦊", "🐺", "🦅", "🐲"];
    
    for (let i = 0; i < max; i++) {
        const p = players[i];
        if (p) {
            const isYou = p.address?.toLowerCase() === state.playerAddr.toLowerCase();
            const name = isYou ? "YOU" : (p.name || shortAddr(p.address));
            html += `
                <div class="player-slot occupied ${isYou ? 'you' : ''} animate-in">
                    ${p.address === state.roomData.host ? '<div class="player-badge-you">HOST</div>' : ''}
                    <div class="player-avatar">${avatars[i % 4]}</div>
                    <div class="player-name">${name}</div>
                    <div class="player-status"><span class="status-dot"></span> Online</div>
                </div>
            `;
        } else {
            html += `
                <div class="player-slot empty">
                    <div class="player-avatar">❓</div>
                    <div class="player-name" style="color: var(--text-dim);">Empty</div>
                    <div class="player-status" style="color: var(--text-dim);">Waiting for player...</div>
                </div>
            `;
        }
    }
    grid.innerHTML = html;
}

// ══════════════════════════════════
//  GAME ACTIONS
// ══════════════════════════════════
function closeCreateRoomModal() {
    const m = $("#createRoomModal");
    m.classList.remove("visible");
    m.style.display = "none";
}

async function createRoom() {
    addLog(`Creating court on <span class="highlight">GenLayer</span>...`);
    closeCreateRoomModal();

    try {
        // 1. Create on Blockchain
        await blockchain.write("create_room", [state.playerName]);
        
        // 2. Get the actual ID
        const total = await blockchain.call("total_rooms", []);
        const roomId = total - 1;

        const roomData = {
            id: roomId,
            name: $("#newRoomName").value.trim() || `Court #${roomId}`,
            theme: state.selectedTheme,
            phase: "LOBBY",
            host: state.playerAddr,
            players: {
                [state.playerAddr]: {
                    name: state.playerName,
                    address: state.playerAddr
                }
            }
        };

        // 3. Sync to Firebase
        await db.ref('rooms/' + roomId).set(roomData);

        state.currentRoomId = roomId;
        showPhase("LOBBY");
        startPolling();
        
        addLog(`Court <span class="highlight">#${roomId}</span> is now ONLINE!`);
    } catch (e) {
        alert("GenLayer Error: " + e.message);
    }
}

async function joinByCode() {
    const code = $("#joinCodeInput").value.trim();
    if (!code || isNaN(code)) return alert("Enter court number!");
    
    if (!state.connected) return alert("Connect wallet first!");

    addLog(`Joining Court <span class="highlight">#${code}</span>...`);

    try {
        // 1. Join on Blockchain
        await blockchain.write("join_room", [parseInt(code), state.playerName]);

        // 2. Sync player to Firebase
        await db.ref(`rooms/${code}/players/${state.playerAddr}`).set({
            name: state.playerName,
            address: state.playerAddr
        });

        state.currentRoomId = code;
        showPhase("LOBBY");
        startPolling();
        
        addLog(`Successfully joined Court <span class="highlight">#${code}</span>!`);
    } catch (e) {
        alert("Join Error: " + e.message);
    }
}

async function startGame() {
    if (!state.currentRoomId) return;
    addLog("Starting Court Session...");
    
    // Update Firebase for immediate UI change
    await db.ref('rooms/' + state.currentRoomId).update({ phase: "CLAIMING" });
    
    // Notify GenLayer (The Judge)
    blockchain.write("start_game", [state.currentRoomId]);
}

async function submitClaim() {
    const text = $("#claimInput").value.trim();
    if (!text) return alert("Write your claim!");
    const isLie = $("#isLieToggle").checked;
    
    addLog(`Submitting claim to <span class="highlight">GenLayer Judge</span>...`);
    
    // 1. Submit to Blockchain
    await blockchain.write("submit_claim", [state.currentRoomId, text, isLie]);
    
    // 2. Mark as submitted in Firebase (so others see you are ready)
    await db.ref(`rooms/${state.currentRoomId}/players/${state.playerAddr}`).update({
        hasSubmitted: true
    });

    state.myClaim = { text, isLie };
    showPhase("WAITING");
    
    // Check if all players in Firebase submitted to move phase
    const snapshot = await db.ref(`rooms/${state.currentRoomId}`).once('value');
    const room = snapshot.val();
    const players = Object.values(room.players);
    if (players.every(p => p.hasSubmitted)) {
        await db.ref(`rooms/${state.currentRoomId}`).update({ phase: "VOTING" });
    }
}

async function submitVotes() {
    addLog("Casting votes...");
    
    // 1. Submit to Blockchain
    await blockchain.write("submit_votes", [state.currentRoomId, JSON.stringify(state.myVotes)]);
    
    // 2. Mark in Firebase
    await db.ref(`rooms/${state.currentRoomId}/players/${state.playerAddr}`).update({
        hasVoted: true
    });

    showPhase("JUDGING");

    // Check if all voted to move to Judging
    const snapshot = await db.ref(`rooms/${state.currentRoomId}`).once('value');
    const room = snapshot.val();
    const players = Object.values(room.players);
    if (players.every(p => p.hasVoted)) {
        await db.ref(`rooms/${state.currentRoomId}`).update({ phase: "JUDGING" });
        
        // Trigger GenLayer AI Judge
        addLog(`AI Judge is searching for evidence...`);
        const results = await blockchain.write("judge_claims", [state.currentRoomId]);
        
        // Final Results to Firebase
        if (results) {
            const finalRoom = await blockchain.call("get_room", [state.currentRoomId]);
            await db.ref(`rooms/${state.currentRoomId}`).update({ 
                phase: "RESULTS",
                results: finalRoom.results,
                winner: finalRoom.winner
            });
        }
    }
}

function showResults(results, winner) {
    $("#resultsOverlay").classList.add("visible");
    $("#winnerName").textContent = `🏆 Winner: ${shortAddr(winner)}`;
    
    let html = "";
    for (const [addr, res] of Object.entries(results)) {
        html += `
            <tr>
                <td><strong>${shortAddr(addr)}</strong></td>
                <td>${res.was_lie ? "🤥 Lie" : "✓ Truth"}</td>
                <td><span class="verdict ${res.was_caught ? 'verdict-caught' : 'verdict-true'}">${res.was_caught ? 'CAUGHT' : 'CLEAN'}</span></td>
                <td class="${res.points >= 0 ? 'points-positive' : 'points-negative'}">${res.points > 0 ? '+' : ''}${res.points}</td>
            </tr>
        `;
    }
    $("#resultsBody").innerHTML = html;
}

// ══════════════════════════════════
//  WALLET & INITIALIZATION
// ══════════════════════════════════
async function connectWallet() {
    if (typeof window.ethereum === "undefined") return alert("Install MetaMask");
    const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
    state.playerAddr = accounts[0];
    state.playerName = shortAddr(state.playerAddr);
    state.connected = true;
    $("#connectWalletBtn").textContent = `⚡ ${state.playerName}`;
    $("#connectWalletBtn").classList.add("connected");
    addLog(`Wallet connected: <span class="highlight">${state.playerName}</span>`);
}

function showPhase(phase) {
    state.currentPhase = phase;
    const sections = ["roomLobby", "claimSection", "votingSection", "judgingSection", "waitingSection"];
    const activeSection = {
        "LOBBY": "roomLobby",
        "CLAIMING": "claimSection",
        "VOTING": "votingSection",
        "JUDGING": "judgingSection",
        "WAITING": "waitingSection"
    }[phase] || "waitingSection";

    sections.forEach(s => $(`#${s}`).style.display = s === activeSection ? "block" : "none");

    $$(".phase-step").forEach(s => {
        s.classList.remove("active", "completed");
        if (s.dataset.phase === phase) s.classList.add("active");
    });
}

function setupEventListeners() {
    $("#connectWalletBtn").onclick = connectWallet;
    const createModal = $("#createRoomModal");
    $("#createRoomBtn").addEventListener("click", () => {
        console.log("Create Room Button Clicked");
        createModal.classList.add("visible");
        createModal.style.display = "flex";
        createModal.style.opacity = "1";
    });
    
    $("#cancelCreateBtn").addEventListener("click", () => {
        createModal.classList.remove("visible");
        createModal.style.display = "none";
    });
    
    $("#confirmCreateBtn").onclick = () => {
        if (!state.connected) {
            alert("⚠️ Please CONNECT WALLET first to submit to GenLayer!");
            return;
        }
        createRoom();
    };
    $("#startGameBtn").onclick = startGame;
    $("#submitClaimBtn").onclick = submitClaim;
    $("#submitVotesBtn").onclick = submitVotes;
    $("#joinByCodeBtn").onclick = joinByCode;
    $("#copyCodeBtn") && ($("#copyCodeBtn").onclick = () => {
        navigator.clipboard.writeText(state.currentRoomId || "");
        $("#copyCodeBtn").textContent = "✅ Copied!";
        setTimeout(() => $("#copyCodeBtn").textContent = "📋 Copy", 2000);
    });
    
    $$("#themeOptions .theme-option").forEach(opt => {
        opt.onclick = () => {
            $$("#themeOptions .theme-option").forEach(o => o.classList.remove("selected"));
            opt.classList.add("selected");
            state.selectedTheme = opt.dataset.theme;
        };
    });

    $("#isLieToggle").onchange = () => {
        const isLie = $("#isLieToggle").checked;
        $("#toggleLabel").textContent = isLie ? "This is a LIE 🤥" : "This is TRUE ✓";
        $("#toggleLabel").style.color = isLie ? "var(--crimson)" : "var(--emerald)";
    };
}

document.addEventListener("DOMContentLoaded", () => {
    setupEventListeners();
    addLog("Bradbury Testnet <span class=\"highlight\">Real-Time</span> Engine Ready.");
    showPhase("LOBBY");
});
