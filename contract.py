from genlayer import *
import genlayer.gl as gl
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
    total_rooms: int
    # room_id -> JSON string of room data
    rooms: TreeMap[int, str]
    # address -> total score
    scores: TreeMap[Address, int]
    # address -> total wins
    wins: TreeMap[Address, int]

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
    def judge_claims(self, room_id: int):
        """
        AI fact-checks all claims using web access + LLM.
        This is the core GenLayer feature: Non-deterministic
        execution with Equivalence Principle consensus.
        """
        room = json.loads(self.rooms[room_id])

        if room["phase"] != "JUDGING":
            raise gl.vm.UserError("Not in judging phase")

        results = {}

        for addr, claim_data in room["claims"].items():
            claim_text = claim_data["text"]

            # ╔═══════════════════════════════════════════╗
            # ║  STEP 1: SEARCH THE WEB FOR EVIDENCE      ║
            # ╚═══════════════════════════════════════════╝
            search_url = f"https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch={claim_text}&format=json&utf8=1"
            web_response = gl.nondet.web.get(search_url)
            web_evidence = web_response.text[:2000]  # Limit size

            # ╔═══════════════════════════════════════════╗
            # ║  STEP 2: AI ANALYZES THE CLAIM             ║
            # ╚═══════════════════════════════════════════╝
            analysis_prompt = f"""You are a fact-checker judge in a game called "Liar's Court".

CLAIM: "{claim_text}"
TOPIC: {room["theme"]}

WEB EVIDENCE (from Wikipedia API):
{web_evidence}

Based on the evidence above, is this claim TRUE or FALSE?
Respond with ONLY one word: TRUE or FALSE"""

            # Use Equivalence Principle so all validators agree
            verdict = gl.eq_principle.prompt_non_comparative(
                analysis_prompt,
                expected_type=str,
            )

            is_actually_true = "TRUE" in verdict.upper()

            # ╔═══════════════════════════════════════════╗
            # ║  STEP 3: CALCULATE POINTS                  ║
            # ╚═══════════════════════════════════════════╝
            player_said_lie = claim_data["is_lie"]
            points = 0

            # Count how many players voted this claim as a LIE
            lie_votes = 0
            for voter, voter_votes in room["votes"].items():
                if voter != addr and addr in voter_votes:
                    if voter_votes[addr] == "LIE":
                        lie_votes += 1

            total_other_players = len(room["players"]) - 1
            was_caught = lie_votes > (total_other_players / 2)

            if player_said_lie and not was_caught:
                # Lied successfully! Nobody caught you
                points = 3
            elif player_said_lie and was_caught:
                # Lied but got caught
                points = -1
            elif not player_said_lie and not is_actually_true:
                # Said truth but AI says it's false (player was wrong)
                points = -1
            elif not player_said_lie and is_actually_true:
                # Told the truth and it checks out
                points = 1

            results[addr] = {
                "verdict": is_actually_true,
                "was_lie": player_said_lie,
                "was_caught": was_caught,
                "lie_votes": lie_votes,
                "points": points,
                "ai_evidence": web_evidence[:200],
            }

            # Update global scores
            current_score = 0
            try:
                current_score = self.scores[Address(bytes.fromhex(addr[2:]))]
            except:
                pass
            self.scores[Address(bytes.fromhex(addr[2:]))] = current_score + points

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
