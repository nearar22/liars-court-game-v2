/**
 * LIAR'S COURT — FIREBASE + GENLAYER AI JUDGE
 * ═══════════════════════════════════════════════
 * Firebase  = ALL game logic (rooms, claims, votes, phases)
 * GenLayer  = AI Judge ONLY (fact-checks claims via LLM consensus)
 *
 * Architecture:
 *  1. Create/Join room → Firebase (instant)
 *  2. Submit Claim     → Firebase (instant)
 *  3. Submit Votes     → Firebase (instant)
 *  4. AI Judging       → Host calls GenLayer contract's judge_claims()
 *                        GenLayer validators run LLM + reach consensus
 *  5. Results          → Saved to Firebase → all clients see it
 *
 * GenLayer interaction uses JSON-RPC directly (no wallet signing needed
 * for the AI judging step since it's triggered via backend-style RPC).
 */

// Global BigInt JSON support — viem, Firebase, and other libs JSON.stringify
// objects that may contain BigInts (block numbers, gas, etc.); without this
// shim they throw "Do not know how to serialize a BigInt".
if (typeof BigInt !== "undefined" && !BigInt.prototype.toJSON) {
    // eslint-disable-next-line no-extend-native
    BigInt.prototype.toJSON = function () { return this.toString(); };
}

const RPC_URL          = "https://zksync-os-testnet-genlayer.zksync.dev/";
const JUDGE_CONTRACT   = "0x07CD2727a3803B3Dc1691852b4Cdfd9e89dc06F0";
const CHAIN_ID_HEX     = "0x107D"; // GenLayer Bradbury = 4221 decimal
const CHAIN_ID_DEC     = 4221;
const EXPLORER_URL     = "https://explorer-bradbury.genlayer.com/";

// ── STATE ──────────────────────────────────────────────
let state = {
    connected:      false,
    currentPhase:   "LOBBY",
    currentRoomId:  null,
    roomData:       null,
    playerName:     "",
    playerAddr:     "",
    selectedTheme:  "Geography",
    myVotes:        {},
    myClaim:        null,
    isHost:         false,
    _judging:       false,
};

// ── HELPERS ────────────────────────────────────────────
const $ = sel => document.querySelector(sel);
const $$ = sel => document.querySelectorAll(sel);
function refreshIcons() { if (window.lucide) lucide.createIcons(); }
function shortAddr(a) { return a ? a.slice(0,6)+"..."+a.slice(38) : "???"; }

// Prevent XSS — sanitize any user-generated text before inserting into HTML
function sanitize(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
}

function addLog(msg) {
    const log = $("#activityLog");
    const t = new Date();
    const hh = t.getHours().toString().padStart(2,"0");
    const mm = t.getMinutes().toString().padStart(2,"0");
    log.insertAdjacentHTML("afterbegin",
        `<li class="log-entry"><span class="log-msg">${msg}</span><span class="log-time">${hh}:${mm}</span></li>`);
    while (log.children.length > 12) log.lastChild.remove();
}

// ── PROFILE SYSTEM ─────────────────────────────────────
const profileCache = {}; // { addr: profile }
let profilesListener = null;

function listenToAllProfiles() {
    if (profilesListener) return;
    profilesListener = db.ref("profiles").on("value", snap => {
        const all = snap.val() || {};
        for (const [addr, p] of Object.entries(all)) {
            profileCache[addr.toLowerCase()] = p;
        }
        // Re-render any active player views
        const room = state._lastRoom;
        if (room) renderPlayers(room.players || {}, room.maxPlayers || 4, room.host);
        loadLeaderboardOnce();
    });
}

function listenToMyProfile() {
    if (!state.playerAddr) return;
    listenToAllProfiles();
    db.ref(`profiles/${state.playerAddr}`).once("value").then(snap => {
        const p = snap.val();
        if (p) {
            profileCache[state.playerAddr.toLowerCase()] = p;
            applyMyProfileToUI(p);
        }
    });
}

function applyMyProfileToUI(p) {
    if (p.avatar) $("#profileBtnAvatar").textContent = p.avatar;
    if (p.displayName) {
        state.playerName = p.displayName;
        $("#connectWalletBtn").textContent = `⚡ ${p.displayName}`;
    }
}

function getProfile(addr) {
    if (!addr) return null;
    return profileCache[addr.toLowerCase()] || null;
}

function profileAvatar(addr, fallback = "🎭") {
    const p = getProfile(addr);
    return p?.avatar || fallback;
}

function profileName(addr) {
    const p = getProfile(addr);
    return p?.displayName || shortAddr(addr || "");
}

function openProfileModal() {
    if (!state.connected) return alert("Connect wallet first!");
    const p = getProfile(state.playerAddr) || {};
    $("#profileName").value    = p.displayName || "";
    $("#profileBio").value     = p.bio || "";
    $("#profileX").value       = p.socials?.x || "";
    $("#profileDiscord").value = p.socials?.discord || "";
    // Mark selected avatar
    const current = p.avatar || "🦊";
    $$(".avatar-option").forEach(b => {
        b.classList.toggle("selected", b.dataset.emoji === current);
    });
    $("#profileModal").classList.add("visible");
}

function closeProfileModal() {
    $("#profileModal").classList.remove("visible");
}

async function saveMyProfile() {
    if (!state.playerAddr) return;
    const selected = $(".avatar-option.selected");
    const profile = {
        avatar:      selected ? selected.dataset.emoji : "🦊",
        displayName: sanitize($("#profileName").value.trim()) || shortAddr(state.playerAddr),
        bio:         sanitize($("#profileBio").value.trim()),
        socials: {
            x:       sanitize($("#profileX").value.trim().replace(/^@/, "")),
            discord: sanitize($("#profileDiscord").value.trim()),
        },
        updatedAt:   Date.now(),
    };
    try {
        await db.ref(`profiles/${state.playerAddr}`).set(profile);
        profileCache[state.playerAddr.toLowerCase()] = profile;
        applyMyProfileToUI(profile);
        showToast("Profile saved!", "success");
        closeProfileModal();
    } catch (err) {
        showToast("Failed to save: " + err.message, "error");
    }
}

function showProfilePopover(addr, anchor) {
    const p = getProfile(addr) || {};
    const pop = $("#profilePopover");
    $("#popAvatar").textContent = p.avatar || "🎭";
    $("#popName").textContent   = p.displayName || shortAddr(addr);
    $("#popAddr").textContent   = shortAddr(addr);
    $("#popBio").textContent    = p.bio || "";
    const socials = $("#popSocials");
    socials.innerHTML = "";
    if (p.socials?.x) {
        socials.insertAdjacentHTML("beforeend",
            `<a class="social-link" target="_blank" rel="noopener" href="https://x.com/${encodeURIComponent(p.socials.x)}">𝕏 ${p.socials.x}</a>`);
    }
    if (p.socials?.discord) {
        socials.insertAdjacentHTML("beforeend",
            `<button class="social-link" data-copy="${p.socials.discord}">💬 ${p.socials.discord}</button>`);
    }
    // Position near anchor
    const rect = anchor.getBoundingClientRect();
    pop.hidden = false;
    const popRect = pop.getBoundingClientRect();
    let left = rect.left + rect.width/2 - popRect.width/2;
    let top  = rect.bottom + 10;
    // Clamp to viewport
    left = Math.max(8, Math.min(left, window.innerWidth - popRect.width - 8));
    if (top + popRect.height > window.innerHeight - 8) {
        top = rect.top - popRect.height - 10;
    }
    pop.style.left = `${left}px`;
    pop.style.top  = `${top}px`;
    // Discord copy handler
    socials.querySelectorAll("[data-copy]").forEach(btn => {
        btn.onclick = () => {
            navigator.clipboard.writeText(btn.dataset.copy);
            showToast("Discord username copied!", "success");
        };
    });
}

function hideProfilePopover() {
    $("#profilePopover").hidden = true;
}

document.addEventListener("click", (e) => {
    const pop = $("#profilePopover");
    if (!pop || pop.hidden) return;
    if (!pop.contains(e.target) && !e.target.closest("[data-player-addr]")) {
        hideProfilePopover();
    }
});

// ── TOAST NOTIFICATIONS ────────────────────────────────
function showToast(msg, type = "info") {
    const container = $("#toastContainer");
    if (!container) return;
    const toast = document.createElement("div");
    toast.className = `toast toast-${type}`;
    toast.textContent = msg;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 3200);
}

// ── CONFETTI ───────────────────────────────────────────
function launchConfetti() {
    const canvas = document.getElementById("confettiCanvas");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    const pieces = [];
    const colors = ["#ffd700","#34d399","#f43f5e","#a78bfa","#22d3ee","#ff8c00"];
    for (let i = 0; i < 150; i++) {
        pieces.push({
            x: Math.random() * canvas.width,
            y: Math.random() * canvas.height - canvas.height,
            w: Math.random() * 8 + 4,
            h: Math.random() * 6 + 2,
            color: colors[Math.floor(Math.random() * colors.length)],
            vx: (Math.random() - 0.5) * 4,
            vy: Math.random() * 3 + 2,
            rot: Math.random() * 360,
            rotSpeed: (Math.random() - 0.5) * 10,
        });
    }
    let frame = 0;
    function draw() {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        let alive = false;
        for (const p of pieces) {
            p.x += p.vx;
            p.y += p.vy;
            p.vy += 0.05;
            p.rot += p.rotSpeed;
            if (p.y < canvas.height + 20) alive = true;
            ctx.save();
            ctx.translate(p.x, p.y);
            ctx.rotate((p.rot * Math.PI) / 180);
            ctx.fillStyle = p.color;
            ctx.globalAlpha = Math.max(0, 1 - frame / 180);
            ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
            ctx.restore();
        }
        frame++;
        if (alive && frame < 200) requestAnimationFrame(draw);
        else ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
    draw();
}

// ── SOUND EFFECTS (Web Audio API — no files needed) ────
const AudioCtx = window.AudioContext || window.webkitAudioContext;
let _audioCtx = null;
function getAudioCtx() { if (!_audioCtx) _audioCtx = new AudioCtx(); return _audioCtx; }

function playSound(type) {
    try {
        const ctx = getAudioCtx();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        gain.gain.value = 0.15;

        if (type === "submit") {
            osc.frequency.setValueAtTime(523, ctx.currentTime);
            osc.frequency.setValueAtTime(659, ctx.currentTime + 0.1);
            osc.frequency.setValueAtTime(784, ctx.currentTime + 0.2);
            gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
            osc.start(); osc.stop(ctx.currentTime + 0.4);
        } else if (type === "vote") {
            osc.frequency.setValueAtTime(440, ctx.currentTime);
            osc.frequency.setValueAtTime(550, ctx.currentTime + 0.08);
            gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.2);
            osc.start(); osc.stop(ctx.currentTime + 0.2);
        } else if (type === "win") {
            osc.frequency.setValueAtTime(523, ctx.currentTime);
            osc.frequency.setValueAtTime(659, ctx.currentTime + 0.15);
            osc.frequency.setValueAtTime(784, ctx.currentTime + 0.3);
            osc.frequency.setValueAtTime(1047, ctx.currentTime + 0.45);
            gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.7);
            osc.start(); osc.stop(ctx.currentTime + 0.7);
        } else if (type === "error") {
            osc.type = "sawtooth";
            osc.frequency.setValueAtTime(200, ctx.currentTime);
            osc.frequency.setValueAtTime(150, ctx.currentTime + 0.15);
            gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
            osc.start(); osc.stop(ctx.currentTime + 0.3);
        } else if (type === "tick") {
            osc.frequency.setValueAtTime(800, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.05);
            osc.start(); osc.stop(ctx.currentTime + 0.05);
        }
    } catch(e) {}
}

// ── COUNTDOWN TIMER ────────────────────────────────────
let countdownInterval = null;
function startCountdown(seconds, onComplete, containerId) {
    clearInterval(countdownInterval);
    const container = containerId ? document.getElementById(containerId) : null;
    const barEl = container ? container.querySelector(".countdown-fill") : document.querySelector(".countdown-fill");
    const textEl = container ? container.nextElementSibling : document.querySelector(".countdown-text");
    if (!barEl) return;
    let remaining = seconds;
    barEl.style.width = "100%";
    if (textEl) { textEl.textContent = `${remaining}s remaining`; textEl.classList.remove("urgent"); }
    countdownInterval = setInterval(() => {
        remaining--;
        const pct = (remaining / seconds) * 100;
        barEl.style.width = pct + "%";
        if (textEl) {
            textEl.textContent = `${remaining}s remaining`;
            if (remaining <= 10) textEl.classList.add("urgent");
        }
        if (remaining <= 0) {
            clearInterval(countdownInterval);
            if (textEl) textEl.textContent = "Time's up!";
            playSound("tick");
            if (onComplete) onComplete();
        }
    }, 1000);
}
function stopCountdown() { clearInterval(countdownInterval); }

// ══════════════════════════════════════════════════════
//  FIREBASE SETUP
// ══════════════════════════════════════════════════════
const firebaseConfig = {
    apiKey:            "AIzaSyAZALzXYxbE6pvUS-2NrVEmo04iH8AFQAA",
    authDomain:        "liars-court.firebaseapp.com",
    databaseURL:       "https://liars-court-default-rtdb.firebaseio.com",
    projectId:         "liars-court",
    storageBucket:     "liars-court.firebasestorage.app",
    messagingSenderId: "737991898395",
    appId:             "1:737991898395:web:ae46b1bbedd0f85c190fbe"
};
firebase.initializeApp(firebaseConfig);
const db = firebase.database();

// ══════════════════════════════════════════════════════
//  GENLAYER RPC HELPER (read-only, no wallet needed)
// ══════════════════════════════════════════════════════
async function glRPC(method, params = []) {
    const body = {
        jsonrpc: "2.0", id: 1,
        method,
        params,
    };
    const res = await fetch(RPC_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    const json = await res.json();
    if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
    return json.result;
}

// ══════════════════════════════════════════════════════
//  WALLET (only for identity, no TX signing needed)
// ══════════════════════════════════════════════════════
async function connectWallet() {
    if (!window.ethereum) return alert("Install MetaMask or Rabby!");
    const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
    state.playerAddr = accounts[0];
    state.playerName = shortAddr(state.playerAddr);
    state.connected  = true;
    $("#connectWalletBtn").textContent = `⚡ ${state.playerName}`;
    $("#connectWalletBtn").classList.add("connected");
    $("#profileBtn").hidden = false;
    listenToMyProfile();
    addLog(`Wallet: <span class="highlight">${state.playerName}</span>`);

    // Check current network
    const chain = await window.ethereum.request({ method: "eth_chainId" });
    if (chain.toLowerCase() !== CHAIN_ID_HEX.toLowerCase()) {
        addLog(`⚠️ Wrong network — switching to <span class="highlight">GenLayer Bradbury</span>`);
        try {
            await window.ethereum.request({
                method: "wallet_switchEthereumChain",
                params: [{ chainId: CHAIN_ID_HEX }],
            });
        } catch (e) {
            if (e.code === 4902 || e.code === -32603) {
                await window.ethereum.request({
                    method: "wallet_addEthereumChain",
                    params: [{
                        chainId: CHAIN_ID_HEX,
                        chainName: "GenLayer Bradbury Testnet",
                        rpcUrls: [RPC_URL],
                        nativeCurrency: { name: "GEN", symbol: "GEN", decimals: 18 },
                        blockExplorerUrls: [EXPLORER_URL],
                    }],
                });
            }
        }
    }
    addLog(`✅ Connected on <span class="highlight">GenLayer Bradbury</span>`);

    // Listen for account changes
    window.ethereum.on("accountsChanged", accs => {
        if (accs.length > 0) {
            state.playerAddr = accs[0];
            state.playerName = shortAddr(state.playerAddr);
            $("#connectWalletBtn").textContent = `⚡ ${state.playerName}`;
        }
    });

    // Auto-reconnect to room if page was reloaded
    const savedCode = sessionStorage.getItem("activeRoom");
    if (savedCode) {
        joinRoom(savedCode).catch(e => console.log("Auto-reconnect failed:", e));
    }
}

// ══════════════════════════════════════════════════════
//  ROOM LISTING (Firebase real-time)
// ══════════════════════════════════════════════════════
function loadRoomList() {
    db.ref("rooms").on("value", snap => {
        const rooms = snap.val() || {};
        const list = $("#roomList");
        list.innerHTML = "";
        let found = false;

        Object.entries(rooms).forEach(([id, room]) => {
            const phase = room.phase || "LOBBY";
            if (phase === "RESULTS" || phase === "JUDGING") return; // hide finished/stuck games

            // Auto-clean stale rooms (> 3 hours old)
            if (room.createdAt && (Date.now() - room.createdAt > 3 * 60 * 60 * 1000)) {
                db.ref("rooms/" + id).remove();
                return;
            }

            const pc = room.players ? Object.keys(room.players).length : 0;
            const isMyRoom = room.host?.toLowerCase() === state.playerAddr?.toLowerCase();
            found = true;

            const li = document.createElement("li");
            li.className = "room-item";
            const phaseLabel = phase.charAt(0) + phase.slice(1).toLowerCase();
            li.innerHTML = `
                <div class="room-item-info">
                    <strong>${sanitize(room.name || "Court")}</strong>
                    <span class="room-item-meta">${sanitize(room.theme)} · ${pc}/${room.maxPlayers||4}</span>
                </div>
                <div class="room-item-actions">
                    <span class="pill pill-violet">${phaseLabel}</span>
                    ${isMyRoom ? `<button class="room-del-btn" title="Delete this room">🗑</button>` : ""}
                    <button class="room-join-btn" data-id="${id}">JOIN</button>
                </div>`;
                
            li.querySelector(".room-join-btn").onclick = () => joinRoom(id);
            if (isMyRoom) {
                li.querySelector(".room-del-btn").onclick = () => {
                    if (confirm("Delete this court?")) {
                        db.ref("rooms/" + id).remove();
                    }
                };
            }
            list.appendChild(li);
        });

        if (!found) {
            list.innerHTML = `
                <li class="room-empty">
                    <div class="room-empty-icon">⚖</div>
                    <div class="room-empty-title">The chamber is silent</div>
                    <div class="room-empty-sub">No active courts yet. Open the first session.</div>
                </li>`;
        }
    });
}

// ══════════════════════════════════════════════════════
//  CREATE ROOM (Firebase only — instant)
// ══════════════════════════════════════════════════════
function closeModal() {
    const m = $("#createRoomModal");
    m.classList.remove("visible");
}

async function createRoom() {
    if (!state.connected) return alert("Connect wallet first!");
    const name   = $("#newRoomName").value.trim() || "Court " + Math.floor(Math.random()*999);
    const maxP   = parseInt($("#maxPlayersSelect").value) || 4;
    const code   = String(Date.now()).slice(-6);
    closeModal();

    const btn = $("#createRoomBtn");
    btn.disabled = true;
    btn.textContent = "CREATING...";

    try {
        const roomData = {
            name: sanitize(name), maxPlayers: maxP,
            theme: state.selectedTheme,
            phase: "LOBBY",
            host:  state.playerAddr,
            createdAt: Date.now(),
            players: { [state.playerAddr]: { name: sanitize(state.playerName), address: state.playerAddr } },
        };
        await db.ref("rooms/" + code).set(roomData);
        state.currentRoomId = code;
        state.isHost = true;
        sessionStorage.setItem("activeRoom", code);
        listenToRoom(code);
        addLog(`Court <span class="highlight">${sanitize(name)}</span> created! Code: <strong>${code}</strong>`);
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i data-lucide="plus-circle" style="width:14px;height:14px;display:inline;vertical-align:middle;margin-right:4px;"></i> Create New Court';
        refreshIcons();
    }
}

// ══════════════════════════════════════════════════════
//  JOIN ROOM
// ══════════════════════════════════════════════════════
async function joinRoom(code) {
    if (!state.connected) return alert("Connect wallet first!");

    const joinBtn = $(`.room-join-btn[data-id="${code}"]`);
    if (joinBtn) { joinBtn.disabled = true; joinBtn.textContent = "JOINING..."; }

    try {
        const snap = await db.ref("rooms/" + code).once("value");
        const room = snap.val();
        if (!room) { alert("Room not found!"); return; }

        const players = room.players ? Object.keys(room.players) : [];
        if (players.length >= (room.maxPlayers||4)) { alert("Room is full!"); return; }

        // Check already in room
        const alreadyIn = players.some(p => p.toLowerCase() === state.playerAddr.toLowerCase());
        if (!alreadyIn) {
            await db.ref(`rooms/${code}/players/${state.playerAddr}`).set({
                name: sanitize(state.playerName), address: state.playerAddr
            });
        }

        state.currentRoomId = code;
        state.isHost = room.host?.toLowerCase() === state.playerAddr.toLowerCase();
        sessionStorage.setItem("activeRoom", code);
        listenToRoom(code);
        addLog(`Joined <span class="highlight">${sanitize(room.name)}</span>!`);
    } finally {
        if (joinBtn) { joinBtn.disabled = false; joinBtn.textContent = "JOIN"; }
    }
}

async function joinByCode() {
    const code = $("#joinCodeInput").value.trim();
    if (!code) return alert("Enter a room code!");
    if (!state.connected) return alert("Connect wallet first!");

    const btn = $("#joinByCodeBtn");
    btn.disabled = true;
    btn.textContent = "JOINING...";
    try {
        await joinRoom(code);
    } finally {
        btn.disabled = false;
        btn.textContent = "JOIN";
    }
}

// ══════════════════════════════════════════════════════
//  REAL-TIME LISTENER
// ══════════════════════════════════════════════════════
let _roomListener = null;

function listenToRoom(code) {
    if (_roomListener) db.ref("rooms/" + _roomListener).off();
    _roomListener = code;

    db.ref("rooms/" + code).on("value", snap => {
        const room = snap.val();
        if (!room) return;
        state.roomData = room;
        state._lastRoom = room;
        state.isHost   = room.host?.toLowerCase() === state.playerAddr.toLowerCase();

        // ── Update UI ──
        $("#lobbyRoomName").textContent = room.name || "Liar's Court";
        $("#lobbyRoomCode").textContent = code;
        $("#themeName").textContent     = room.theme || "Geography";

        const themes = { Geography:"🌍", History:"📜", Science:"🔬", Sports:"⚽", Technology:"💻", Random:"🎲" };
        $(".theme-icon").textContent = themes[room.theme] || "🌍";

        const players = room.players ? Object.values(room.players) : [];
        renderPlayers(players, room.maxPlayers||4, room.host);

        // ── Start button ──
        const startBtn = $("#startGameBtn");
        if (room.phase === "LOBBY") {
            if (state.isHost) {
                startBtn.disabled = players.length < 2;
                startBtn.textContent = players.length < 2
                    ? `NEED 2+ PLAYERS (${players.length})`
                    : "▶ START GAME";
            } else {
                startBtn.disabled = true;
                startBtn.textContent = "WAITING FOR HOST...";
            }
        }

        // ── Phase sync ──
        const prevPhase = state.currentPhase;
        if (room.phase !== prevPhase) {
            state.currentPhase = room.phase;
            $("#resultsOverlay").classList.remove("visible"); // always close modal on phase switch
            
            if (room.phase === "LOBBY") {
                // Reset purely local tracking and UI forms for ALL players (hosts and guests)
                state.myClaim  = null;
                state.myVotes  = {};
                state._judging = false;
                
                $("#claimInput").value = "";
                $("#isLieToggle").checked = false;
                $("#submitClaimBtn").textContent = "SUBMIT TO COURT";
                $("#submitClaimBtn").disabled = false;
                $("#submitVotesBtn").textContent = "SUBMIT VERDICT";
                $("#submitVotesBtn").disabled = false;
            }

            showPhase(room.phase);
            stopCountdown();

            if (room.phase === "CLAIMING") {
                showToast("Make your claim! You have 60 seconds.", "info");
                startCountdown(60, () => {
                    if (!state.myClaim) showToast("Time's up! Submit now!", "warning");
                }, "claimCountdown");
            }
            if (room.phase === "VOTING" && room.claims) {
                buildVotingUI(room.claims);
                showToast("Vote on each claim! 45 seconds.", "info");
                startCountdown(45, () => {
                    showToast("Hurry! Voting ends soon.", "warning");
                }, "voteCountdown");
            }
            // HOST triggers AI judge when phase moves to JUDGING
            if (room.phase === "JUDGING" && state.isHost && !state._judging) {
                state._judging = true;
                showToast("GenLayer AI is analyzing claims...", "info");
                triggerAIJudge(room).finally(() => { state._judging = false; });
            }
            if (room.phase === "RESULTS" && room.results) {
                showResults(room.results, room.winner, room.claims, room.judgeTx);
                launchConfetti();
                playSound("win");
                const wd = room.results[room.winner];
                showToast(`${wd?.username || "Winner"} wins the round!`, "success");
            }
        }

        // ── If reconnecting mid-game ──
        if (room.phase === "VOTING" && prevPhase === "LOBBY" && room.claims) {
            buildVotingUI(room.claims);
        }
        if (room.phase === "RESULTS" && room.results) {
            showResults(room.results, room.winner, room.claims, room.judgeTx);
        }
    });
}

// ══════════════════════════════════════════════════════
//  RENDER PLAYERS
// ══════════════════════════════════════════════════════
function renderPlayers(players, max, host) {
    const grid   = $("#playersGrid");
    const fallbacks = ["🦊","🐺","🦅","🐲"];
    let html = "";
    for (let i = 0; i < max; i++) {
        const p = players[i];
        if (p) {
            const addr   = p.address || "";
            const isYou  = addr.toLowerCase() === state.playerAddr.toLowerCase();
            const isHost = addr.toLowerCase() === host?.toLowerCase();
            const avatar = profileAvatar(addr, fallbacks[i%4]);
            const name   = profileName(addr) !== shortAddr(addr) ? profileName(addr) : (p.name || shortAddr(addr));
            html += `<div class="player-slot occupied ${isYou?"you":""} animate-in" data-player-addr="${addr}">
                ${isHost ? '<div class="player-badge-you">HOST</div>' : ""}
                <div class="player-avatar">${avatar}</div>
                <div class="player-name">${isYou ? "YOU" : name}</div>
                <div class="player-status"><span class="status-dot"></span> Online</div>
            </div>`;
        } else {
            html += `<div class="player-slot empty">
                <div class="player-avatar">❓</div>
                <div class="player-name" style="color:var(--text-dim)">Empty</div>
                <div class="player-status" style="color:var(--text-dim)">Waiting...</div>
            </div>`;
        }
    }
    grid.innerHTML = html;
    // Attach popover triggers
    grid.querySelectorAll("[data-player-addr]").forEach(slot => {
        slot.onclick = (e) => {
            e.stopPropagation();
            const addr = slot.dataset.playerAddr;
            if (!addr) return;
            showProfilePopover(addr, slot);
        };
    });
}

// ══════════════════════════════════════════════════════
//  START GAME (Firebase only — no GenLayer TX needed)
// ══════════════════════════════════════════════════════
async function startGame() {
    if (!state.currentRoomId || !state.isHost) return;

    const btn = $("#startGameBtn");
    btn.disabled = true;
    btn.textContent = "STARTING...";
    addLog("Starting game...");
    showLoadingBanner("Starting game...");

    try {
        await db.ref("rooms/" + state.currentRoomId).update({
            phase: "CLAIMING",
            roundId: Date.now(), // unique per round → contract key is fresh on every restart
        });

        hideLoadingBanner();
        addLog("🏛️ Game started! Submit your claims.");
    } catch (err) {
        hideLoadingBanner();
        btn.disabled = false;
        btn.textContent = "▶ START GAME";
        addLog(`❌ Error: ${err.message}`);
    }
}

// ══════════════════════════════════════════════════════
//  SUBMIT CLAIM (Firebase only — instant)
// ══════════════════════════════════════════════════════
async function submitClaim() {
    const text  = $("#claimInput").value.trim();
    if (!text) return alert("Write your claim!");
    const isLie = $("#isLieToggle").checked;

    const btn = $("#submitClaimBtn");
    btn.disabled = true;
    btn.textContent = "SUBMITTING...";

    try {
        // Save claim to Firebase (sanitized for XSS)
        await db.ref(`rooms/${state.currentRoomId}/claims/${state.playerAddr}`).set({
            text: sanitize(text), isLie, username: sanitize(state.playerName)
        });
        state.myClaim = { text, isLie };
        addLog("✅ Claim submitted!");
        showToast("Claim submitted!", "success");
        playSound("submit");
        stopCountdown();

        // Check if all players submitted → move to VOTING (using transaction to prevent race condition)
        const roomRef = db.ref("rooms/" + state.currentRoomId);
        await roomRef.transaction(currentRoom => {
            if (!currentRoom) return currentRoom;
            const pc = currentRoom.players ? Object.keys(currentRoom.players).length : 0;
            const cc = currentRoom.claims ? Object.keys(currentRoom.claims).length : 0;
            if (cc >= pc && currentRoom.phase === "CLAIMING") {
                currentRoom.phase = "VOTING";
            }
            return currentRoom;
        });
        // Show waiting if still in CLAIMING
        const snap = await roomRef.once("value");
        const room = snap.val();
        if (room && room.phase === "CLAIMING") {
            const pc = Object.keys(room.players).length;
            const cc = room.claims ? Object.keys(room.claims).length : 0;
            showPhase("WAITING");
            $("#waitingText").textContent = `Waiting for ${pc - cc} more player(s)...`;
        }
    } catch (err) {
        addLog(`❌ Claim Error: ${err.message}`);
        btn.disabled = false;
        btn.textContent = "SUBMIT TO COURT";
    }
}

// ══════════════════════════════════════════════════════
//  VOTING UI
// ══════════════════════════════════════════════════════
function buildVotingUI(claims) {
    state.myVotes = {};
    const grid = $("#claimsGrid");
    let html = `<h3 style="grid-column:1/-1;color:var(--purple);margin-bottom:0.5rem;">
        🕵️ Vote on each claim: Truth or Lie?
    </h3>`;

    let hasOtherClaims = false;
    for (const [addr, claim] of Object.entries(claims)) {
        if (addr.toLowerCase() === state.playerAddr.toLowerCase()) continue;
        hasOtherClaims = true;
        const name = claim.username || shortAddr(addr);
        html += `
            <div class="card claim-card" style="padding:1.5rem;" data-addr="${addr}">
                <p style="color:var(--purple);font-size:0.75rem;font-weight:600;margin-bottom:0.5rem;">
                    ${name} claims:
                </p>
                <p style="font-size:1rem;color:var(--text);margin-bottom:1.2rem;line-height:1.5;">
                    "${claim.text}"
                </p>
                <div style="display:flex;gap:0.6rem;">
                    <button class="vbtn truth-btn" data-addr="${addr}" data-vote="TRUTH"
                        style="flex:1;padding:0.75rem;border:2px solid var(--emerald);
                               background:transparent;color:var(--emerald);border-radius:8px;
                               cursor:pointer;font-weight:700;font-family:var(--font);
                               font-size:0.85rem;transition:all 0.2s;">
                        ✓ TRUTH
                    </button>
                    <button class="vbtn lie-btn" data-addr="${addr}" data-vote="LIE"
                        style="flex:1;padding:0.75rem;border:2px solid var(--crimson);
                               background:transparent;color:var(--crimson);border-radius:8px;
                               cursor:pointer;font-weight:700;font-family:var(--font);
                               font-size:0.85rem;transition:all 0.2s;">
                        🤥 LIE
                    </button>
                </div>
            </div>`;
    }

    if (!hasOtherClaims) {
        html += `<p style="grid-column:1/-1;color:var(--text-muted);text-align:center;">
            No other claims to vote on yet...</p>`;
    }

    grid.innerHTML = html;

    // Attach vote handlers
    grid.querySelectorAll(".vbtn").forEach(btn => {
        btn.onclick = () => {
            const addr = btn.dataset.addr;
            const vote = btn.dataset.vote;
            state.myVotes[addr] = vote;

            // Reset both buttons for this claim
            grid.querySelectorAll(`[data-addr="${addr}"]`).forEach(b => {
                if (!b.dataset.vote) return;
                const isTruth = b.dataset.vote === "TRUTH";
                b.style.background = "transparent";
                b.style.color = isTruth ? "var(--emerald)" : "var(--crimson)";
                b.style.boxShadow = "none";
            });
            // Highlight selected
            const isT = vote === "TRUTH";
            btn.style.background  = isT ? "var(--emerald)" : "var(--crimson)";
            btn.style.color       = "#000";
            btn.style.boxShadow   = `0 0 15px ${isT ? "var(--emerald-glow)" : "var(--crimson-glow)"}`;
        };
    });
}

// ══════════════════════════════════════════════════════
//  SUBMIT VOTES (Firebase only — instant)
// ══════════════════════════════════════════════════════
async function submitVotes() {
    if (Object.keys(state.myVotes).length === 0) return alert("Vote on at least one claim!");

    const btn = $("#submitVotesBtn");
    btn.disabled = true;
    btn.textContent = "SUBMITTING...";

    try {
        // Save votes to Firebase
        await db.ref(`rooms/${state.currentRoomId}/votes/${state.playerAddr}`).set(state.myVotes);
        addLog("✅ Votes recorded!");
        showToast("Votes submitted!", "success");
        playSound("vote");
        stopCountdown();

        // Check if all voted → move to JUDGING (using transaction to prevent race condition)
        const roomRef = db.ref("rooms/" + state.currentRoomId);
        await roomRef.transaction(currentRoom => {
            if (!currentRoom) return currentRoom;
            const pc = currentRoom.players ? Object.keys(currentRoom.players).length : 0;
            const vc = currentRoom.votes ? Object.keys(currentRoom.votes).length : 0;
            if (vc >= pc && currentRoom.phase === "VOTING") {
                currentRoom.phase = "JUDGING";
            }
            return currentRoom;
        });
        // Show waiting if still in VOTING
        const snap = await roomRef.once("value");
        const room = snap.val();
        if (room && room.phase === "VOTING") {
            const pc = Object.keys(room.players).length;
            const vc = room.votes ? Object.keys(room.votes).length : 0;
            showPhase("WAITING");
            $("#waitingText").textContent = `Waiting for ${pc - vc} more player(s)...`;
        }
    } catch (err) {
        addLog(`❌ Vote Error: ${err.message}`);
        btn.disabled = false;
        btn.textContent = "SUBMIT VERDICT";
    }
}

// ══════════════════════════════════════════════════════
//  AI JUDGE — Uses GenLayer AI for fact-checking
//  This is called by the HOST when all votes are in.
//  Instead of sending a blockchain TX, we do the AI
//  analysis locally using the claim data from Firebase,
//  simulating what GenLayer's LLM consensus would do.
// ══════════════════════════════════════════════════════
async function triggerAIJudge(room) {
    showLoadingBanner("🤖 AI Judge analyzing claims...");

    try {
        const claims = room.claims || {};
        const votes  = room.votes || {};
        const players = room.players || {};
        // Unique contract session key per round (avoids stale verdicts on replay in same room)
        const sessionKey = `${state.currentRoomId}_${room.roundId || Date.now()}`;

        addLog("🧠 AI Judge is fact-checking all claims...");
        addLog(`📡 Querying GenLayer AI on <span class="highlight">Bradbury Testnet</span>...`);

        // ══════════════════════════════════════════════
        //  STEP 1: AI FACT-CHECK via GenLayer SDK
        //  Uses genlayer-js writeContract (same as snake-protocol)
        //  Validators run LLM + reach consensus via Equivalence Principle
        // ══════════════════════════════════════════════
        let verdicts = {};
        
        // Build the claims JSON for AI analysis
        // Format: "0xAddr: \"claim text\"\n" per line
        const claimAddrs = Object.keys(claims);
        let claimsSummary = "";
        for (const addr of claimAddrs) {
            claimsSummary += `${addr}: "${claims[addr].text}"\n`;
        }
        
        // ── GenLayer SDK — AI FACT-CHECK via on-chain LLM consensus ──
        if (!window.GenLayerBridge || !window.ethereum) {
            throw new Error("GenLayer Bridge or MetaMask not detected. Install MetaMask and refresh.");
        }

        addLog(`📡 Connecting to <span class="highlight">Bradbury Testnet</span>...`);

        // Override chain RPC so SDK's internal publicClient uses our working RPC
        // (rpc-bradbury.genlayer.com is currently unreachable)
        const bradbury = window.GenLayerBridge.chains.testnetBradbury;
        const customChain = Object.assign({}, bradbury, {
            rpcUrls: { default: { http: [RPC_URL] } }
        });

        const glClient = window.GenLayerBridge.createClient({
            chain: customChain,
            account: state.playerAddr,
            provider: window.ethereum,
        });

        // Switch wallet to GenLayer Bradbury network
        try {
            await window.ethereum.request({
                method: "wallet_switchEthereumChain",
                params: [{ chainId: CHAIN_ID_HEX }],
            });
        } catch (switchErr) {
            if (switchErr.code === 4902) {
                await window.ethereum.request({
                    method: "wallet_addEthereumChain",
                    params: [{
                        chainId: CHAIN_ID_HEX,
                        chainName: "GenLayer Bradbury Testnet",
                        nativeCurrency: { name: "GEN", symbol: "GEN", decimals: 18 },
                        rpcUrls: [RPC_URL],
                        blockExplorerUrls: [EXPLORER_URL],
                    }],
                });
            } else {
                throw switchErr;
            }
        }
        addLog("🔗 Wallet on Bradbury Testnet");

        // ── STEP 1: Send TX to GenLayer (LLM consensus via validators) ──
        addLog("⛓️ Sending AI judge TX to GenLayer...");

        let txHash = null;
        let fullTx  = null;
        const judgeStart = Date.now();

        // Retry writeContract up to 3 times with exponential backoff
        const MAX_RETRIES = 3;
        for (let attempt = 1; attempt <= MAX_RETRIES && !txHash; attempt++) {
            try {
                if (attempt > 1) {
                    const delay = 3000 * attempt;
                    addLog(`🔄 Retry attempt ${attempt}/${MAX_RETRIES}...`);
                    showToast(`Retrying GenLayer TX (attempt ${attempt})...`, "warning");
                    await new Promise(r => setTimeout(r, delay));
                }
                txHash = await glClient.writeContract({
                    address: JUDGE_CONTRACT,
                    functionName: "judge_claims",
                    args: [sessionKey, room.theme || "General Knowledge", claimsSummary],
                    value: BigInt(0),
                    leaderOnly: true,
                });
            } catch (txErr) {
                console.warn(`[GenLayer] writeContract attempt ${attempt} failed:`, txErr.message);
                if (attempt === MAX_RETRIES) {
                    addLog("⚠️ GenLayer TX could not be submitted — using fallback.");
                    showToast("AI Judge unavailable. Using declaration-based verdicts.", "warning");
                }
            }
        }

        if (txHash) {
            addLog(`📝 TX: <a href="${EXPLORER_URL}tx/${txHash}" target="_blank">${txHash.substring(0, 12)}…</a>`);
            addLog("⏳ Waiting for GenLayer consensus...");

            // ── STEP 2: Wait for receipt — race fastest status that has leader output ──
            // Since our `strict_eq` output is deterministic (booleans only), the leader's
            // result at COMMITTING/PROPOSING already matches the final ACCEPTED state.
            // Waiting for COMMITTING is much faster than full ACCEPTED consensus.
            const tryStatus = (status, retries, interval) => glClient.waitForTransactionReceipt({
                hash: txHash,
                status,
                retries,
                interval,
                fullTransaction: true,
            });
            try {
                // Race: whichever status returns first wins. Most common is COMMITTING (fastest
                // with leader output present). We also race ACCEPTED in case the TX is already
                // past COMMITTING by the time we start polling.
                const fastPromise = Promise.any([
                    tryStatus("COMMITTING", 40, 3000),
                    tryStatus("ACCEPTED",   40, 3000),
                ]);
                const timeoutPromise = new Promise((_, reject) =>
                    setTimeout(() => reject(new Error("Timeout: consensus took longer than 2 minutes")), 2 * 60 * 1000)
                );
                fullTx = await Promise.race([fastPromise, timeoutPromise]);
                console.log("[GenLayer] Full TX receipt:", JSON.stringify(fullTx).substring(0, 2000));
                addLog("✅ GenLayer leader output received!");
            } catch (receiptErr) {
                console.warn("[GenLayer] Receipt error:", receiptErr);
                addLog("⚠️ Consensus delayed — using fallback.");
                showToast(receiptErr.message?.includes("Timeout") ? "AI Judge timed out. Using fallback." : "Consensus failed. Using fallback.", "warning");
            }
        }

        // Ensure judging screen shows for at least 4 seconds
        const elapsed = Date.now() - judgeStart;
        if (elapsed < 4000) await new Promise(r => setTimeout(r, 4000 - elapsed));

        // ── STEP 3: Extract verdicts from consensus data ──
        if (fullTx) {
            // Search the TX data for JSON verdicts
            const txStr = JSON.stringify(fullTx, (k, v) => typeof v === "bigint" ? v.toString() : v);
            console.log("[GenLayer] Searching TX data for verdicts...", txStr.substring(0, 500));

            // Try leader_receipt → result → payload (contains strict_eq output)
            const cd = fullTx.consensus_data || fullTx.consensusData || {};
            const leaderReceipts = cd.leader_receipt || cd.leaderReceipt || [];
            for (const lr of (Array.isArray(leaderReceipts) ? leaderReceipts : [leaderReceipts])) {
                const payload = lr?.result?.payload || lr?.genvm_result?.stdout || "";
                if (payload && payload.includes("{")) {
                    try {
                        const parsed = JSON.parse(payload);
                        for (const [key, value] of Object.entries(parsed)) {
                            for (const addr of claimAddrs) {
                                if (key.includes(addr) || addr.includes(key)) {
                                    verdicts[addr] = !!value;
                                }
                            }
                        }
                    } catch (e) { console.warn("Parse attempt:", e); }
                }
                // Also check eq_outputs
                const eqOut = lr?.eq_outputs || {};
                for (const eqVal of Object.values(eqOut)) {
                    if (typeof eqVal === "string" && eqVal.includes("{")) {
                        try {
                            const parsed = JSON.parse(eqVal);
                            for (const [key, value] of Object.entries(parsed)) {
                                for (const addr of claimAddrs) {
                                    if (key.includes(addr) || addr.includes(key)) {
                                        verdicts[addr] = !!value;
                                    }
                                }
                            }
                        } catch (e) { console.warn("EQ parse attempt:", e); }
                    }
                }
            }

            // Bradbury runtime stores strict_eq output in `eqBlocksOutputs` (hex-encoded).
            // Decode hex → ascii and look for the verdicts JSON object.
            if (Object.keys(verdicts).length === 0) {
                const eqHex = fullTx.eqBlocksOutputs || fullTx.eq_blocks_outputs || "";
                if (typeof eqHex === "string" && eqHex.startsWith("0x")) {
                    try {
                        const cleanHex = eqHex.slice(2);
                        let asciiStr = "";
                        for (let i = 0; i + 1 < cleanHex.length; i += 2) {
                            const ch = parseInt(cleanHex.substr(i, 2), 16);
                            asciiStr += (ch >= 32 && ch < 127) ? String.fromCharCode(ch) : " ";
                        }
                        // Find first JSON object containing addresses + booleans
                        const jsonRe = /\{[^{}]*"0x[a-fA-F0-9]{40}"[^{}]*\}/g;
                        const matches = asciiStr.match(jsonRe);
                        if (matches) {
                            for (const m of matches) {
                                try {
                                    const parsed = JSON.parse(m);
                                    for (const [key, value] of Object.entries(parsed)) {
                                        for (const addr of claimAddrs) {
                                            if (key.toLowerCase() === addr.toLowerCase()) {
                                                verdicts[addr] = !!value;
                                            }
                                        }
                                    }
                                } catch (_) {}
                            }
                        }
                    } catch (decodeErr) {
                        console.warn("[GenLayer] eqBlocksOutputs decode error:", decodeErr);
                    }
                }
            }

            // Fallback: search entire TX JSON for a JSON-like verdict pattern
            if (Object.keys(verdicts).length === 0) {
                const jsonMatch = txStr.match(/\{[^{}]*"0x[a-fA-F0-9]+"[^{}]*:[\s]*(true|false)[^{}]*\}/g);
                if (jsonMatch) {
                    for (const match of jsonMatch) {
                        try {
                            const parsed = JSON.parse(match);
                            for (const [key, value] of Object.entries(parsed)) {
                                for (const addr of claimAddrs) {
                                    if (key.includes(addr) || addr.includes(key)) {
                                        verdicts[addr] = !!value;
                                    }
                                }
                            }
                        } catch (e) {}
                    }
                }
            }
        }

        // ── STEP 4: If no verdicts from TX data, try readContract (gen_call) ──
        if (Object.keys(verdicts).length === 0) {
            addLog("📖 Trying to read verdicts from contract state...");
            try {
                const resultStr = await glClient.readContract({
                    address: JUDGE_CONTRACT,
                    functionName: "get_verdicts",
                    args: [sessionKey],
                });
                console.log("[GenLayer] readContract result:", resultStr);
                if (resultStr && resultStr !== "{}" && resultStr !== "null") {
                    const parsed = JSON.parse(resultStr);
                    for (const [key, value] of Object.entries(parsed)) {
                        for (const addr of claimAddrs) {
                            if (key.includes(addr) || addr.includes(key)) {
                                verdicts[addr] = !!value;
                            }
                        }
                    }
                }
            } catch (readErr) {
                console.warn("[GenLayer] readContract error:", readErr.message);
                addLog("⚠️ Read error: " + readErr.message.substring(0, 60));
            }
        }

        let aiVerified = false;
        if (Object.keys(verdicts).length > 0) {
            aiVerified = true;
            addLog("✅ AI Verdicts extracted from GenLayer!");
        } else {
            // ── FALLBACK: use player's own isLie declaration as the AI verdict ──
            // (AI unavailable — trust declarations: truth=true, lie=false)
            addLog("⚖️ GenLayer unavailable — verdicts from declarations.");
            for (const addr of claimAddrs) {
                const claimData = claims[addr];
                verdicts[addr] = claimData.isLie !== true;
            }
            showToast("⚠️ AI Judge offline — verdicts based on declarations", "warning");
            addLog("✅ Declaration-based verdicts computed (AI fallback mode).");
        }

        addLog("✅ AI Verdict reached!");

        // ══════════════════════════════════════════════
        //  STEP 2: CALCULATE POINTS
        // ══════════════════════════════════════════════
        const results = {};
        
        for (const [addr, claimData] of Object.entries(claims)) {
            const isActuallyTrue = verdicts[addr] !== undefined ? verdicts[addr] : true;
            const playerSaidLie = claimData.isLie === true;
            let points = 0;

            // Count lie votes for this player
            let lieVotes = 0;
            for (const [voter, voterVotes] of Object.entries(votes)) {
                if (voter !== addr && voterVotes[addr]) {
                    if (voterVotes[addr] === "LIE") lieVotes++;
                }
            }

            const totalOtherPlayers = Object.keys(players).length - 1;
            const wasCaught = lieVotes > (totalOtherPlayers / 2);

            if (playerSaidLie && !wasCaught) {
                points = 3; // Successful lie!
            } else if (playerSaidLie && wasCaught) {
                points = -1; // Caught lying
            } else if (!playerSaidLie && !isActuallyTrue) {
                points = -1; // Wrong truth
            } else if (!playerSaidLie && isActuallyTrue) {
                points = 1; // Truth confirmed
            }

            results[addr] = {
                verdict: isActuallyTrue,
                ai_verified: aiVerified,
                was_lie: playerSaidLie,
                was_caught: wasCaught,
                lie_votes: lieVotes,
                points: points,
                text: claimData.text,
                username: claimData.username || shortAddr(addr),
            };
        }

        // Add voter bonus points
        for (const [voter, voterVotes] of Object.entries(votes)) {
            let voterBonus = 0;
            for (const [targetAddr, voteValue] of Object.entries(voterVotes)) {
                if (targetAddr in claims) {
                    const actualLie = claims[targetAddr].isLie === true;
                    if (voteValue === "LIE" && actualLie) {
                        voterBonus += 1; // Correctly spotted a lie
                    } else if (voteValue === "TRUTH" && !actualLie) {
                        voterBonus += 1; // Correctly identified truth
                    }
                }
            }
            if (voter in results) {
                results[voter].points += voterBonus;
            }
        }

        // Determine winner
        let winner = "";
        let bestScore = -999;
        for (const [addr, res] of Object.entries(results)) {
            if (res.points > bestScore) {
                bestScore = res.points;
                winner = addr;
            }
        }

        // ══════════════════════════════════════════════
        //  STEP 3: SAVE RESULTS TO FIREBASE
        // ══════════════════════════════════════════════
        await db.ref("rooms/" + state.currentRoomId).update({
            phase:    "RESULTS",
            results:  results,
            winner:   winner,
            judgeTx:  txHash || null,
        });

        hideLoadingBanner();
        addLog("🏆 Results are in!");
        
        // Update leaderboard
        updateLeaderboard(results);
        if (winner) {
            db.ref(`leaderboard/${winner}/wins`).transaction(w => (w || 0) + 1);
        }

    } catch (err) {
        console.error("AI Judge error:", err);
        addLog(`❌ AI Judge error: ${err.message}`);
        hideLoadingBanner();
    }
}

// ══════════════════════════════════════════════════════
//  RESULTS DISPLAY
// ══════════════════════════════════════════════════════
function showResults(results, winner, claims, judgeTx) {
    // Remove any old notes / TX badges
    $$("#winnerName ~ p, #judgeTxLink").forEach(n => n.remove());
    $("#resultsOverlay").classList.add("visible");
    const wd = results[winner];
    $("#winnerName").textContent = wd?.username || shortAddr(winner);

    // Show on-chain TX link so anyone can verify the AI judgement on the explorer.
    if (judgeTx) {
        const link = document.createElement("a");
        link.id = "judgeTxLink";
        link.href = `${EXPLORER_URL}tx/${judgeTx}`;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = `🔗 Verify AI judgement on Bradbury · ${judgeTx.substring(0, 10)}…${judgeTx.substring(judgeTx.length - 6)}`;
        link.style.cssText = "display:inline-block;margin:0.5rem auto 0.75rem;padding:0.4rem 0.85rem;border:1px solid var(--purple);border-radius:8px;color:var(--purple);font-size:0.72rem;font-weight:700;text-decoration:none;letter-spacing:0.04em;";
        $("#winnerName").after(link);
    }

    let html = "";
    for (const [addr, res] of Object.entries(results)) {
        const claimText  = res.text || claims?.[addr]?.text || "—";
        const declared   = res.was_lie ? "🤥 Declared: LIE" : "✓ Declared: TRUTH";

        // AI verdict badge (honest about source: real AI vs declaration fallback)
        let aiBadge = "";
        const verdictPrefix = res.ai_verified ? "🤖 AI FACT-CHECK" : "⚖️ DECLARATION TRUSTED";
        if (res.verdict === true)  aiBadge = `<div style="font-size:0.65rem;color:#4ade80;margin-top:3px;font-weight:700;">${verdictPrefix}: TRUE ✅</div>`;
        if (res.verdict === false) aiBadge = `<div style="font-size:0.65rem;color:#f97316;margin-top:3px;font-weight:700;">${verdictPrefix}: FALSE 🚨</div>`;

        // Points explanation
        let why = "";
        if (res.was_lie && !res.was_caught)           why = "Got away with the lie! 😎";
        else if (res.was_lie && res.was_caught)       why = "Players caught your lie 👮";
        else if (!res.was_lie && res.verdict===false) why = "AI caught a fake fact 🤖";
        else if (!res.was_lie && res.verdict===true)  why = "Truth verified! 🌟";
        else                                          why = "Truth teller";

        // Verdict badge
        let verdictBadge = "";
        let verdictClass = "";
        if (res.was_lie && res.was_caught) {
            verdictBadge = "CAUGHT"; verdictClass = "verdict-caught";
        } else if (res.was_lie && !res.was_caught) {
            verdictBadge = "ESCAPED"; verdictClass = "verdict-true";
        } else if (!res.was_lie && res.verdict === false) {
            verdictBadge = "WRONG"; verdictClass = "verdict-caught";
        } else if (!res.was_lie && res.verdict === true) {
            verdictBadge = "CORRECT"; verdictClass = "verdict-true";
        } else {
            verdictBadge = "CLEAN"; verdictClass = "verdict-true";
        }

        html += `<tr>
            <td><strong>${res.username || shortAddr(addr)}</strong></td>
            <td>
                <div style="font-size:0.82rem;line-height:1.5;margin-bottom:4px;">"${claimText}"</div>
                <div style="font-size:0.65rem;font-weight:700;color:var(--text-muted);">${declared}</div>
                ${aiBadge}
            </td>
            <td>
                <span class="verdict ${verdictClass}">
                    ${verdictBadge}
                </span>
                <div style="font-size:0.6rem;color:var(--text-dim);margin-top:4px;">${why}</div>
            </td>
            <td>
                <span class="${res.points>=0?"points-positive":"points-negative"}">
                    ${res.points>0?"+":""}${res.points}
                </span>
            </td>
        </tr>`;
    }
    $("#resultsBody").innerHTML = html;
    
    // Update play again button based on role
    const paBtn = $("#playAgainBtn");
    if (paBtn) {
        if (state.isHost) {
            paBtn.disabled = false;
            paBtn.textContent = "PLAY AGAIN / RESTART";
            paBtn.style.opacity = "1";
        } else {
            paBtn.disabled = true;
            paBtn.textContent = "WAITING FOR HOST TO RESTART...";
            paBtn.style.opacity = "0.6";
        }
    }
}

// ══════════════════════════════════════════════════════
//  LOADING BANNER
// ══════════════════════════════════════════════════════
function showLoadingBanner(msg) {
    let b = $("#loadingBanner");
    if (!b) {
        b = document.createElement("div");
        b.id = "loadingBanner";
        b.style.cssText = `position:fixed;bottom:1.5rem;left:50%;transform:translateX(-50%);
            background:rgba(10,10,20,0.95);border:1px solid var(--purple);border-radius:12px;
            padding:0.75rem 1.5rem;color:var(--purple);font-family:var(--font);font-size:0.85rem;
            z-index:500;display:flex;align-items:center;gap:0.75rem;box-shadow:0 0 30px var(--purple-glow);`;
        document.body.appendChild(b);
    }
    b.innerHTML = `<div class="spinner" style="width:20px;height:20px;border-width:2px;margin:0;"></div> ${msg}`;
    b.style.display = "flex";
}
function hideLoadingBanner() {
    const b = $("#loadingBanner");
    if (b) b.style.display = "none";
}

// ══════════════════════════════════════════════════════
//  PHASE MANAGEMENT
// ══════════════════════════════════════════════════════
function showPhase(phase) {
    state.currentPhase = phase;
    
    // Toggle welcome screen vs room UI
    if (phase === "NONE" || !state.currentRoomId) {
        $("#welcomeSection").style.display = "block";
        $("#phaseBar").style.display = "none";
        $("#themeBanner").style.display = "none";
        ["roomLobby","claimSection","votingSection","judgingSection","waitingSection"]
            .forEach(s => { const el = $(`#${s}`); if(el) el.style.display = "none"; });
        return;
    } else {
        $("#welcomeSection").style.display = "none";
        $("#phaseBar").style.display = "flex";
        $("#themeBanner").style.display = "flex";
    }

    const map = {
        LOBBY:    "roomLobby",
        CLAIMING: "claimSection",
        VOTING:   "votingSection",
        JUDGING:  "judgingSection",
        WAITING:  "waitingSection",
    };
    const active = map[phase] || "waitingSection";
    ["roomLobby","claimSection","votingSection","judgingSection","waitingSection"]
        .forEach(s => { const el = $(`#${s}`); if(el) el.style.display = s === active ? "block" : "none"; });

    const phaseOrder = ["LOBBY", "CLAIMING", "VOTING", "JUDGING", "RESULTS"];
    const currentIdx = phaseOrder.indexOf(phase);
    $$(".phase-step").forEach(s => {
        s.classList.remove("active", "completed");
        const stepIdx = phaseOrder.indexOf(s.dataset.phase);
        if (s.dataset.phase === phase) {
            s.classList.add("active");
        } else if (stepIdx >= 0 && currentIdx >= 0 && stepIdx < currentIdx) {
            s.classList.add("completed");
        }
    });
    refreshIcons();
}

// ══════════════════════════════════════════════════════
//  EVENT LISTENERS
// ══════════════════════════════════════════════════════
function setupEventListeners() {
    $("#connectWalletBtn").onclick = connectWallet;

    const modal = $("#createRoomModal");
    $("#createRoomBtn").addEventListener("click", () => {
        modal.classList.add("visible");
    });
    $("#cancelCreateBtn").addEventListener("click", closeModal);
    $("#confirmCreateBtn").onclick = createRoom;

    // ── Profile ──
    $("#profileBtn").onclick = openProfileModal;
    $("#cancelProfileBtn").onclick = closeProfileModal;
    $("#saveProfileBtn").onclick = saveMyProfile;
    $("#avatarPicker").addEventListener("click", (e) => {
        const btn = e.target.closest(".avatar-option");
        if (!btn) return;
        $$(".avatar-option").forEach(b => b.classList.remove("selected"));
        btn.classList.add("selected");
    });

    $("#startGameBtn").onclick   = startGame;
    $("#submitClaimBtn").onclick = submitClaim;
    $("#submitVotesBtn").onclick = submitVotes;
    $("#joinByCodeBtn").onclick  = joinByCode;

    const copyBtn = $("#copyCodeBtn");
    if (copyBtn) copyBtn.onclick = () => {
        navigator.clipboard.writeText(state.currentRoomId || "");
        copyBtn.textContent = "✅ Copied!";
        setTimeout(() => copyBtn.textContent = "📋 Copy", 2000);
    };

    const playAgain = $("#playAgainBtn");
    if (playAgain) playAgain.onclick = async () => {
        if (!state.isHost) {
            alert("Only the Host can restart the court!");
            return;
        }

        $("#playAgainBtn").disabled = true;
        $("#playAgainBtn").textContent = "RESTARTING...";

        if (state.currentRoomId) {
            // Host resets the room for everyone
            await db.ref("rooms/" + state.currentRoomId).update({
                phase: "LOBBY",
                claims: null,
                votes: null,
                verdicts: null,
                results: null,
                winner: null
            });
            addLog("🔄 Host restarted the game!");
        }
        
        // Reset purely local tracking flags
        state.myClaim  = null;
        state.myVotes  = {};
        state._judging = false;
        
        // Reset UI form states
        $("#claimInput").value = "";
        $("#isLieToggle").checked = false;
        $("#submitClaimBtn").textContent = "SUBMIT TO AI JUDGE";
        $("#submitClaimBtn").disabled = false;
        $("#submitVotesBtn").textContent = "SUBMIT VERDICT";
        $("#submitVotesBtn").disabled = false;
        
        $("#playAgainBtn").disabled = false;
        $("#playAgainBtn").textContent = "PLAY AGAIN";
        hideLoadingBanner();
    };
    
    const leaveRoomBtn = $("#leaveRoomBtn");
    if (leaveRoomBtn) leaveRoomBtn.onclick = async () => {
        if (!confirm("Are you sure you want to leave the court?")) return;
        
        if (state.currentRoomId) {
            if (state.isHost) {
                await db.ref("rooms/" + state.currentRoomId).remove();
                addLog("🔴 Court closed!");
            } else {
                await db.ref(`rooms/${state.currentRoomId}/players/${state.playerAddr}`).remove();
                addLog("🚪 You left the court.");
            }
        }
        
        sessionStorage.removeItem("activeRoom");
        if (_roomListener) { db.ref("rooms/" + _roomListener).off(); _roomListener = null; }
        state.currentRoomId = null;
        state.currentPhase = "LOBBY";
        state.roomData = null;
        state.isHost = false;
        
        showPhase("NONE");
        loadRoomList();
    };

    $$("#themeOptions .theme-option").forEach(opt => {
        opt.onclick = () => {
            $$("#themeOptions .theme-option").forEach(o => o.classList.remove("selected"));
            opt.classList.add("selected");
            state.selectedTheme = opt.dataset.theme;
        };
    });

    $("#isLieToggle").onchange = () => {
        const lie = $("#isLieToggle").checked;
        $("#toggleLabel").textContent = lie ? "This is a LIE 🤥" : "This is TRUE ✓";
        $("#toggleLabel").style.color = lie ? "var(--crimson)" : "var(--emerald)";
    };
}

// ══════════════════════════════════════════════════════
//  INIT
// ══════════════════════════════════════════════════════
document.addEventListener("DOMContentLoaded", () => {
    setupEventListeners();
    loadRoomList();
    loadLeaderboard();
    addLog(`Bradbury Testnet <span class="highlight">GenLayer Engine</span> Ready.`);
    showPhase("NONE");
    refreshIcons();
});

// ══════════════════════════════════════════════════════
//  LEADERBOARD
// ══════════════════════════════════════════════════════
let _leaderboardEntries = [];

function renderLeaderboard() {
    const lb = $("#leaderboard");
    if (!lb) return;
    if (_leaderboardEntries.length === 0) {
        lb.innerHTML = `
            <li class="lb-empty">
                <div class="lb-empty-icon">♛</div>
                <div class="lb-empty-text">No verdicts yet. Be the first liar.</div>
            </li>`;
        return;
    }
    const tags = ["Master Perjurer", "Silver Tongue", "Convincing", "Apprentice", "Initiate"];
    let html = "";
    _leaderboardEntries.forEach((e, i) => {
        const rankClass = i < 3 ? `rank-${i+1}` : "";
        const tag = tags[i] || "Initiate";
        const avatar = profileAvatar(e.addr, "🎭");
        const name   = profileName(e.addr) !== shortAddr(e.addr) ? profileName(e.addr) : e.name;
        html += `<li class="lb-entry" data-player-addr="${e.addr}" style="cursor:pointer">
            <span class="lb-rank ${rankClass}">${i+1}</span>
            <span class="lb-avatar" style="font-size:18px;line-height:1">${avatar}</span>
            <div class="lb-info"><span class="lb-name">${name}</span><span class="lb-tag">${tag}</span></div>
            <span class="lb-score">${e.score}</span>
        </li>`;
    });
    lb.innerHTML = html;
    lb.querySelectorAll("[data-player-addr]").forEach(li => {
        li.onclick = (e) => {
            e.stopPropagation();
            showProfilePopover(li.dataset.playerAddr, li);
        };
    });
}

function loadLeaderboardOnce() { renderLeaderboard(); }

function loadLeaderboard() {
    db.ref("leaderboard").orderByChild("score").limitToLast(5).on("value", snap => {
        const data = snap.val() || {};
        _leaderboardEntries = Object.entries(data)
            .map(([addr, d]) => ({ addr, score: d.score || 0, wins: d.wins || 0, name: d.name || shortAddr(addr) }))
            .sort((a, b) => b.score - a.score);
        renderLeaderboard();
    });
}

// Update leaderboard after game results
function updateLeaderboard(results) {
    if (!results) return;
    for (const [addr, res] of Object.entries(results)) {
        const ref = db.ref(`leaderboard/${addr}`);
        ref.transaction(current => {
            if (!current) current = { score: 0, wins: 0, name: res.username || shortAddr(addr) };
            current.score = (current.score || 0) + (res.points || 0);
            current.name  = res.username || current.name;
            return current;
        });
    }
}
