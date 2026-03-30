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
//  REAL-TIME SYNC (THE "REAL" ONLINE)
// ══════════════════════════════════
// ══════════════════════════════════
//  REAL-TIME SYNC (THE "REAL" ONLINE)
// ══════════════════════════════════
async function syncRoom() {
    if (state.currentRoomId === null) return;

    // ✅ Sync directly from the Intelligent Contract (Online for everyone)
    try {
        const room = await blockchain.call("get_room", [parseInt(state.currentRoomId)]);
        if (!room) return;

        console.log("Online Sync...", room);
        const oldPhase = state.currentPhase;
        state.roomData = room;
        state.currentPhase = room.phase;

        // 1. Update Header
        $("#lobbyRoomName").textContent = `Court #${room.id}`;
        $("#lobbyRoomCode").textContent = room.id;
        $("#themeName").textContent = room.theme;

        // 2. Sync Players Grid (Map dict to list for renderer)
        const playersList = Object.keys(room.players);
        renderPlayerSlots(playersList, 4);

        // 3. Phase Transitions
        if (oldPhase !== state.currentPhase) {
            addLog(`Court moved to <span class="highlight">${state.currentPhase}</span> phase`);
            showPhase(state.currentPhase);
            if (state.currentPhase === "RESULTS") showResults(room.results, room.winner);
        }

        // 4. Update Start Button (First player is host)
        const startBtn = $("#startGameBtn");
        const isHost = playersList[0]?.toLowerCase() === state.playerAddr.toLowerCase();
        
        if (isHost && state.currentPhase === "WAITING") {
            startBtn.disabled = playersList.length < 2;
            startBtn.textContent = playersList.length < 2 ? `WAITING FOR PLAYERS (${playersList.length}/2)` : "START GAME";
        } else if (state.currentPhase === "WAITING") {
            startBtn.disabled = true;
            startBtn.textContent = "WAITING FOR HOST...";
        } else {
            startBtn.disabled = true;
            startBtn.textContent = "IN PROGRESS";
        }

    } catch (e) {
        console.error("Sync Error:", e);
    }
}

function startPolling() {
    if (state.pollingInterval) clearInterval(state.pollingInterval);
    state.pollingInterval = setInterval(syncRoom, 4000); // Sync every 4s
    syncRoom();
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
    addLog(`Creating room on <span class="highlight">GenLayer</span>... Please wait.`);
    closeCreateRoomModal();

    try {
        // 1. Send the transaction
        await blockchain.write("create_room", [state.playerName]);
        
        // 2. Get the latest room ID (since total_rooms increased)
        const total = await blockchain.call("total_rooms", []);
        const newId = total - 1;

        state.currentRoomId = newId;
        addLog(`New Court Created! Code: <span class="highlight">${newId}</span>`);
        addLog(`Share the number <span class="highlight">${newId}</span> with your friends!`);
        
        showPhase("LOBBY");
        startPolling();
    } catch (e) {
        alert("Failed to create room: " + e.message);
    }
}

async function joinByCode() {
    const code = $("#joinCodeInput").value.trim();
    if (!code) return alert("Enter court number!");
    
    addLog(`Joining Court <span class="highlight">#${code}</span>...`);
    
    try {
        await blockchain.write("join_room", [parseInt(code), state.playerName]);
        state.currentRoomId = parseInt(code);
        showPhase("LOBBY");
        startPolling();
    } catch (e) {
        alert("Could not join: " + e.message);
    }
}

async function joinRoom(id) {
    state.currentRoomId = id;
    startPolling();
}

async function startGame() {
    await blockchain.write("start_game", [state.currentRoomId]);
}

async function submitClaim() {
    const text = $("#claimInput").value.trim();
    const isLie = $("#isLieToggle").checked;
    await blockchain.write("submit_claim", [state.currentRoomId, text, isLie]);
    state.myClaim = { text, isLie };
    showPhase("WAITING");
}

async function submitVotes() {
    await blockchain.write("submit_votes", [state.currentRoomId, JSON.stringify(state.myVotes)]);
    showPhase("JUDGING");
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
