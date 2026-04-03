# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }
from genlayer import *
import json


THEMES = [
    "Geography & Countries",
    "History & Wars",
    "Science & Nature",
    "Sports & Records",
    "Technology & Inventions",
    "Food & Culture",
    "Space & Universe",
    "Animals & Wildlife",
]


class LiarsCourt(gl.Contract):
    
    # ═══════════════════════════════════════
    #  STORAGE
    # ═══════════════════════════════════════
    total_rooms: u64
    # room_id -> JSON string of room data
    rooms: TreeMap[u64, str]
    # address -> total score
    scores: TreeMap[Address, i64]
    # address -> total wins
    wins: TreeMap[Address, u64]

    def __init__(self):
        self.total_rooms = 0

    # ═══════════════════════════════════════
    #  ROOM MANAGEMENT
    # ═══════════════════════════════════════

    @gl.public.write
    def create_room(self, username: str) -> int:
        """Create a new game room. Returns room_id."""
        room_id = self.total_rooms
        room = {
            "id": room_id,
            "phase": "WAITING",       # WAITING -> CLAIMING -> VOTING -> JUDGING -> RESULTS
            "theme": THEMES[room_id % len(THEMES)],
            "players": {str(gl.message.sender): username},
            "claims": {},             # address -> {"text": ..., "is_lie": bool}
            "votes": {},              # voter_address -> {claim_address: "LIE" or "TRUTH"}
            "results": {},            # address -> {"verdict": bool, "points": int, "ai_source": str}
            "round": 1,
            "max_rounds": 3,
            "winner": "",
        }
        self.rooms[room_id] = json.dumps(room)
        self.total_rooms += 1
        return room_id

    @gl.public.write
    def join_room(self, room_id: int, username: str):
        """Join an existing room (max 4 players)."""
        room = json.loads(self.rooms[room_id])
        if len(room["players"]) >= 4:
            raise gl.vm.UserError("Room is full (max 4 players)")
        if room["phase"] != "WAITING":
            raise gl.vm.UserError("Game already started")
        room["players"][str(gl.message.sender)] = username
        self.rooms[room_id] = json.dumps(room)

    @gl.public.write
    def start_game(self, room_id: int):
        """Start the game once enough players have joined (min 2)."""
        room = json.loads(self.rooms[room_id])
        if len(room["players"]) < 2:
            raise gl.vm.UserError("Need at least 2 players")
        if room["phase"] != "WAITING":
            raise gl.vm.UserError("Game already started")
        room["phase"] = "CLAIMING"
        self.rooms[room_id] = json.dumps(room)

    # ═══════════════════════════════════════
    #  PHASE 1: SUBMIT CLAIMS
    # ═══════════════════════════════════════

    @gl.public.write
    def submit_claim(self, room_id: int, claim_text: str, is_lie: bool):
        """
        Submit a claim about the real world.
        is_lie: True if the player is intentionally lying.
        The other players won't see the is_lie flag.
        """
        room = json.loads(self.rooms[room_id])
        sender = str(gl.message.sender)

        if room["phase"] != "CLAIMING":
            raise gl.vm.UserError("Not in claiming phase")
        if sender not in room["players"]:
            raise gl.vm.UserError("You are not in this room")
        if sender in room["claims"]:
            raise gl.vm.UserError("You already submitted a claim")

        room["claims"][sender] = {
            "text": claim_text,
            "is_lie": is_lie,
            "username": room["players"][sender],
        }

        # If all players submitted, move to voting
        if len(room["claims"]) == len(room["players"]):
            room["phase"] = "VOTING"

        self.rooms[room_id] = json.dumps(room)

    # ═══════════════════════════════════════
    #  PHASE 2: VOTE ON CLAIMS
    # ═══════════════════════════════════════

    @gl.public.write
    def submit_votes(self, room_id: int, votes_json: str):
        """
        Submit votes on other players' claims.
        votes_json: JSON string like {"0xAddr1": "LIE", "0xAddr2": "TRUTH"}
        """
        room = json.loads(self.rooms[room_id])
        sender = str(gl.message.sender)

        if room["phase"] != "VOTING":
            raise gl.vm.UserError("Not in voting phase")
        if sender not in room["players"]:
            raise gl.vm.UserError("You are not in this room")
        if sender in room["votes"]:
            raise gl.vm.UserError("You already voted")

        player_votes = json.loads(votes_json)
        room["votes"][sender] = player_votes

        # If all players voted, move to AI judging
        if len(room["votes"]) == len(room["players"]):
            room["phase"] = "JUDGING"

        self.rooms[room_id] = json.dumps(room)

    # ═══════════════════════════════════════
    #  PHASE 3: AI FACT-CHECK (THE MAGIC)
    # ═══════════════════════════════════════

    @gl.public.write
    def judge_claims_direct(self, theme: str, claims_json: str) -> str:
        """
        AI fact-checks claims passed directly from the frontend.
        No room lookup needed — claims come from Firebase via the caller.
        Uses nondet so validators don't need to agree exactly on LLM output.
        Returns a JSON string: {"0xAddr1": true, "0xAddr2": false}
        """
        batch_prompt = f"""You are a strict fact-checker judge in a game called "Liar's Court".
THEME: {theme}

CLAIMS TO CHECK:
{claims_json}

TASK: For each player's claim, determine if it is factually TRUE or FALSE based on your knowledge.
Be lenient — if the claim is generally accurate, mark it true.
Only mark false if the claim is clearly and obviously wrong.
Respond with a JSON object where keys are the exact player addresses and values are booleans.
Example: {{"0xAddr1": true, "0xAddr2": false}}
Return ONLY the raw JSON object. No markdown, no explanation."""

        def ask_llm() -> str:
            raw = gl.nondet.exec_prompt(batch_prompt)
            raw = raw.replace("```json", "").replace("```", "").strip()
            parsed = json.loads(raw)
            return json.dumps(parsed, sort_keys=True)

        return gl.eq_principle.nondet(ask_llm)

    @gl.public.write
    def judge_claims(self, room_id: int):
        """
        AI fact-checks all claims using web access + LLM.
        This is the core GenLayer feature: Non-deterministic
        execution with Equivalence Principle consensus.
        """
        room = json.loads(self.rooms[room_id])

        if room["phase"] != "JUDGING":
            raise gl.vm.UserError("Not in judging phase")

        # ╔═══════════════════════════════════════════╗
        # ║  STEP 1: PREPARE BATCH PROMPT             ║
        # ╚═══════════════════════════════════════════╝
        claims_summary = ""
        for i, (addr, claim_data) in enumerate(room["claims"].items()):
            claims_summary += f"PLAYER_{i+1} ({addr}): \"{claim_data['text']}\"\n"

        batch_prompt = f"""You are a fact-checker judge in a game called "Liar's Court".
THEME: {room["theme"]}

CLAIMS TO CHECK:
{claims_summary}

TASK: For each player's claim, determine if it is factually TRUE or FALSE based on your general knowledge and the theme.
Be lenient — if the claim is generally true or mostly accurate, mark it as true.
Only mark false if the claim is clearly, obviously wrong.
Respond with a JSON object where keys are the exact player addresses and values are booleans.
Example: {{"0xAddr1": true, "0xAddr2": false}}
Return ONLY the raw JSON object. No markdown, no explanation."""

        # Use Equivalence Principle for consensus on the whole batch
        def ask_llm() -> str:
            raw = gl.nondet.exec_prompt(batch_prompt)
            raw = raw.replace("```json", "").replace("```", "").strip()
            parsed = json.loads(raw)
            return json.dumps(parsed, sort_keys=True)

        verdicts_json = gl.eq_principle.strict_eq(ask_llm)
        
        try:
            verdicts = json.loads(verdicts_json)
        except:
            # Fallback if AI fails to return proper JSON
            verdicts = {}

        # ╔═══════════════════════════════════════════╗
        # ║  STEP 2: CALCULATE POINTS FOR ALL          ║
        # ╚═══════════════════════════════════════════╝
        results = {}
        for addr, claim_data in room["claims"].items():
            is_actually_true = verdicts.get(addr, True) # Default to true if missing
            player_said_lie = claim_data["is_lie"]
            points = 0

            # Count votes
            lie_votes = 0
            for voter, voter_votes in room["votes"].items():
                if voter != addr and addr in voter_votes:
                    if voter_votes[addr] == "LIE":
                        lie_votes += 1

            total_other_players = len(room["players"]) - 1
            was_caught = lie_votes > (total_other_players / 2)

            if player_said_lie and not was_caught:
                points = 3 # Successful lie
            elif player_said_lie and was_caught:
                points = -1 # Caught lying
            elif not player_said_lie and not is_actually_true:
                points = -1 # Wrong truth
            elif not player_said_lie and is_actually_true:
                points = 1 # Truth confirmed

            results[addr] = {
                "verdict": is_actually_true,
                "was_lie": player_said_lie,
                "was_caught": was_caught,
                "lie_votes": lie_votes,
                "points": points,
            }

            # Update scores
            try:
                p_addr = Address(bytes.fromhex(addr[2:]))
                self.scores[p_addr] = (self.scores[p_addr] or 0) + points
            except:
                pass

        # Assign voter points (for correct guesses)
        for voter, voter_votes in room["votes"].items():
            voter_bonus = 0
            for target_addr, vote_value in voter_votes.items():
                if target_addr in results:
                    actual_lie = room["claims"][target_addr]["is_lie"]
                    if vote_value == "LIE" and actual_lie:
                        voter_bonus += 1  # Correctly spotted a lie!
                    elif vote_value == "TRUTH" and not actual_lie:
                        voter_bonus += 1  # Correctly identified truth
            if voter in results:
                results[voter]["points"] += voter_bonus

        room["results"] = results
        room["phase"] = "RESULTS"

        # Determine winner
        best_player = ""
        best_score = -999
        for addr, res in results.items():
            if res["points"] > best_score:
                best_score = res["points"]
                best_player = addr
        room["winner"] = best_player

        # Update wins
        if best_player:
            current_wins = 0
            try:
                current_wins = self.wins[Address(bytes.fromhex(best_player[2:]))]
            except:
                pass
            self.wins[Address(bytes.fromhex(best_player[2:]))] = current_wins + 1

        self.rooms[room_id] = json.dumps(room)

    # ═══════════════════════════════════════
    #  BATCH AI JUDGE (called from frontend)
    # ═══════════════════════════════════════

    @gl.public.write
    def judge_claims_batch(self, theme: str, claims_json: str) -> str:
        """
        AI fact-checks claims via GenLayer LLM consensus.
        Uses gl.nondet.exec_prompt + gl.eq_principle.strict_eq
        (same proven pattern as snake-protocol).
        Returns JSON: {"0xAddr1": true, "0xAddr2": false}
        """
        def ask_llm() -> str:
            prompt = f"""You are a strict trivia fact-checker for a game called "Liar's Court".
THEME: {theme}

CLAIMS TO CHECK:
{claims_json}

For each claim, determine if it is factually TRUE or FALSE in the real world.
Respond ONLY with a JSON object where keys are the player identifiers and values are booleans.
Example: {{"CLAIM_1 (0xAddr1)": true, "CLAIM_2 (0xAddr2)": false}}
No markdown, no explanation, ONLY valid JSON."""
            raw = gl.nondet.exec_prompt(prompt)
            raw = raw.replace("```json", "").replace("```", "").strip()
            parsed = json.loads(raw)
            return json.dumps(parsed, sort_keys=True)

        result_str = gl.eq_principle.strict_eq(ask_llm)
        return result_str

    # ═══════════════════════════════════════
    #  READ METHODS
    # ═══════════════════════════════════════

    @gl.public.view
    def get_room(self, room_id: int) -> str:
        """Get room data (hides is_lie from claims during active game)."""
        room = json.loads(self.rooms[room_id])
        # Hide lies during active play
        if room["phase"] in ["CLAIMING", "VOTING", "JUDGING"]:
            safe_claims = {}
            for addr, claim in room["claims"].items():
                safe_claims[addr] = {
                    "text": claim["text"],
                    "username": claim["username"],
                }
            room["claims"] = safe_claims
        return json.dumps(room)

    @gl.public.view
    def get_score(self, player: Address) -> int:
        """Get a player's total score."""
        try:
            return self.scores[player]
        except:
            return 0

    @gl.public.view
    def get_wins(self, player: Address) -> int:
        """Get a player's total wins."""
        try:
            return self.wins[player]
        except:
            return 0

    @gl.public.view
    def get_total_rooms(self) -> int:
        """Get the total number of rooms created."""
        return self.total_rooms

    @gl.public.view
    def get_room_phase(self, room_id: int) -> str:
        """Quick check: get only the current phase of a room."""
        try:
            room = json.loads(self.rooms[room_id])
            return room.get("phase", "UNKNOWN")
        except:
            return "NOT_FOUND"
