/**
 * enemy-coach.js
 *
 * The AI Enemy Coach — operates exclusively as the IGL (In-Game Leader)
 * for the enemy team (bots). It never advises the human player's side.
 *
 * Responsibilities:
 *  1. Receive a parsed GameState from gsi-parser.js
 *  2. Build a concise tactical prompt for Claude
 *  3. Call the Anthropic API (claude-haiku-4-5) with streaming
 *  4. Stream the response to stdout for real-time terminal feedback
 *  5. Return the final call string to index.js → bot-commander.js
 *
 * Throttle: only one call is issued per unique (roundNumber, roundPhase)
 * combination to avoid hammering the API within the same tactical window.
 */

import Anthropic from "@anthropic-ai/sdk";

// ---------------------------------------------------------------------------
// Client setup
// ---------------------------------------------------------------------------

const client = new Anthropic();
// API key is read automatically from process.env.ANTHROPIC_API_KEY

// ---------------------------------------------------------------------------
// Throttle state
// ---------------------------------------------------------------------------

/**
 * Tracks the last (roundNumber, roundPhase) combination for which a call was
 * already issued. Resets on every new combination.
 * @type {{ roundNumber: number|null, roundPhase: string|null }}
 */
const lastCall = {
  roundNumber: null,
  roundPhase: null,
};

/**
 * Returns true if we should skip calling the API for this game state.
 * @param {import("./gsi-parser.js").GameState} gameState
 * @returns {boolean}
 */
function isThrottled(gameState) {
  return (
    lastCall.roundNumber === gameState.roundNumber &&
    lastCall.roundPhase === gameState.roundPhase
  );
}

/**
 * Updates the throttle tracker after a successful API call.
 * @param {import("./gsi-parser.js").GameState} gameState
 */
function updateThrottle(gameState) {
  lastCall.roundNumber = gameState.roundNumber;
  lastCall.roundPhase = gameState.roundPhase;
}

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

/**
 * Formats a bomb state into a readable tactical sentence.
 * @param {import("./gsi-parser.js").GameState["bomb"]} bomb
 * @param {string} roundPhase
 * @returns {string}
 */
function formatBombStatus(bomb, roundPhase) {
  switch (bomb.state) {
    case "carried":
      return "Bomb is being carried (not yet planted).";
    case "planted":
      return `Bomb is PLANTED${bomb.position ? ` at ${bomb.position}` : ""}. ${
        bomb.countdown ? `${Math.round(bomb.countdown)}s remaining.` : ""
      }`;
    case "defusing":
      return `Bomb is being DEFUSED. ${
        bomb.countdown ? `${Math.round(bomb.countdown)}s until defuse.` : ""
      }`;
    case "defused":
      return "Bomb has been defused — round over.";
    case "exploded":
      return "Bomb exploded — round over.";
    default:
      return "Bomb status unknown.";
  }
}

/**
 * Formats alive player names into a readable list.
 * @param {import("./gsi-parser.js").TeamState} teamState
 * @returns {string}
 */
function formatAlivePlayers(teamState) {
  if (teamState.aliveCount === 0) return "none (team eliminated)";
  return teamState.alivePlayers.map((p) => p.name).join(", ");
}

/**
 * Builds the tactical prompt sent to Claude.
 * Only enemyTeam data is exposed — this coach has no insight into human plans.
 *
 * @param {import("./gsi-parser.js").GameState} gameState
 * @returns {string}
 */
function buildPrompt(gameState) {
  const { enemyTeam, humanTeam, roundPhase, roundNumber, bomb, mapName } =
    gameState;

  const enemySide = enemyTeam.side;
  const humanSide = humanTeam.side;

  const bombInfo = formatBombStatus(bomb, roundPhase);

  // Phase label for context
  const phaseLabel = {
    freezetime: "Freeze time (buy phase)",
    live: "Round is live",
    bomb: "Bomb is planted",
    defuse: "Bomb is being defused",
    over: "Round just ended",
  }[roundPhase] ?? roundPhase;

  return `You are the IGL (In-Game Leader) for the ${enemySide} team in a Counter-Strike 2 match.

## Current Situation
- Map: ${mapName}
- Round: ${roundNumber}
- Phase: ${phaseLabel}

## Your Team (${enemySide})
- Players alive: ${formatAlivePlayers(enemyTeam)} (${enemyTeam.aliveCount}/${enemyTeam.players.length})
- Economy: $${enemyTeam.totalMoney} total → classified as **${enemyTeam.economy}**

## Enemy (${humanSide})
- Players alive: ${formatAlivePlayers(humanTeam)} (${humanTeam.aliveCount}/${humanTeam.players.length})

## Bomb
- ${bombInfo}

## Your Task
Issue ONE short, direct, actionable tactical call for your ${enemySide} team right now — exactly as an elite IGL would say it over voice comms.

Rules:
- Maximum 2 sentences.
- Be specific: name sites, positions, or roles when relevant (e.g., "Two go A long, three hold mid. If no contact in 45s, rotate B.").
- Account for economy: if it's an eco round, prioritize defensive play or pistol aggression; if full-buy, play for information first.
- ${enemySide === "T" ? "As T-side, decide whether to execute, fake, split, or play for picks." : "As CT-side, decide whether to stack, hold default, play aggressive early, or rotate."}
- Do NOT explain your reasoning. Just give the call.`;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Generates a tactical call for the enemy team and streams it to the terminal.
 *
 * Returns null if the state is throttled (already called for this round/phase),
 * or if the enemy team is eliminated (no call needed).
 *
 * @param {import("./gsi-parser.js").GameState} gameState
 * @returns {Promise<string|null>} The full tactical call text, or null.
 */
export async function generateEnemyCall(gameState) {
  // Skip dead rounds
  if (gameState.enemyTeam.aliveCount === 0) {
    return null;
  }

  // Skip phases that don't need a call
  if (gameState.roundPhase === "over") {
    return null;
  }

  // Throttle: one call per (roundNumber, roundPhase) window
  if (isThrottled(gameState)) {
    return null;
  }

  // Mark as issued before await so concurrent GSI ticks don't double-fire
  updateThrottle(gameState);

  const mockCall = "Rush B — all bots go bombsite_b immediately";
  console.log("\n" + "─".repeat(60));
  console.log(`🎯 [Enemy Coach MOCK] Round ${gameState.roundNumber} | ${gameState.enemyTeam.side}`);
  console.log(`📢 Call: "${mockCall}"`);
  console.log("─".repeat(60) + "\n");

  const prompt = buildPrompt(gameState);

  console.log("\n" + "─".repeat(60));
  console.log(
    `🎯 [Enemy Coach] Round ${gameState.roundNumber} | Phase: ${gameState.roundPhase} | ${gameState.enemyTeam.side} | Economy: ${gameState.enemyTeam.economy}`
  );
  console.log("─".repeat(60));
  process.stdout.write("📢 Call: ");

  // let fullCall = "";

  // // Stream the response so the terminal shows words as they arrive
  // const stream = await client.messages.stream({
  //   model: "claude-haiku-4-5-20251001",
  //   max_tokens: 120,
  //   messages: [{ role: "user", content: prompt }],
  // });

  // for await (const chunk of stream) {
  //   if (
  //     chunk.type === "content_block_delta" &&
  //     chunk.delta?.type === "text_delta"
  //   ) {
  //     const text = chunk.delta.text;
  //     process.stdout.write(text);
  //     fullCall += text;
  //   }
  // }

  // // Ensure the call ends with a newline in the terminal
  // console.log("\n" + "─".repeat(60) + "\n");

  return mockCall; //fullCall.trim();
}
