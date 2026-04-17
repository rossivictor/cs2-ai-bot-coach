/**
 * index.js
 *
 * Entry point for the CS2 AI Enemy Coach server.
 *
 * Starts an Express HTTP server that:
 *  1. Listens for CS2 Game State Integration (GSI) POST payloads on /gsi
 *  2. Parses the game state via gsi-parser.js
 *  3. Forwards the enemy team state to enemy-coach.js for tactical decisions
 *  4. Passes the resulting call to bot-commander.js for (future) execution
 *
 * Setup:
 *  1. Copy gamestate_integration_ai_coach.cfg to your CS2 cfg directory:
 *       C:\Program Files (x86)\Steam\steamapps\common\Counter-Strike Global Offensive\game\csgo\cfg\
 *  2. Set ANTHROPIC_API_KEY in .env
 *  3. Run: node index.js   (or: npm start)
 */

import "dotenv/config";
import express from "express";
import { writeFileSync } from "fs";
import { parseGameState } from "./gsi-parser.js";
import { parseCssState } from "./css-parser.js";
import { generateEnemyCall } from "./enemy-coach.js";
import { executeCall } from "./bot-commander.js";

// ---------------------------------------------------------------------------
// Validate environment
// ---------------------------------------------------------------------------

if (!process.env.ANTHROPIC_API_KEY) {
  console.error(
    "[Startup] ERROR: ANTHROPIC_API_KEY is not set. Add it to your .env file and restart."
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Debug payload collector
// ---------------------------------------------------------------------------

// Tracks which round numbers have been seen with phase "over"
const completedRounds = new Set();

// Accumulated payload entries: [{ timestamp, roundNumber, roundPhase, payload }]
const debugPayloads = [];

// Flip to true once 3 rounds complete — stops all further collection
let debugComplete = false;

const DEBUG_ROUND_TARGET = 3;
const DEBUG_OUTPUT_FILE = "debug_payloads.json";

/**
 * Records a payload snapshot to the in-memory buffer and flushes to disk.
 * Marks debug as complete once DEBUG_ROUND_TARGET distinct rounds have ended.
 *
 * @param {object} payload - Raw GSI payload.
 */
function collectDebugPayload(payload) {
  if (debugComplete) return;

  const roundNumber = payload?.map?.round ?? null;
  const roundPhase  = payload?.round?.phase ?? payload?.map?.phase ?? "unknown";

  // Record this snapshot
  debugPayloads.push({
    timestamp: new Date().toISOString(),
    roundNumber,
    roundPhase,
    payload,
  });

  // A round is "complete" when CS2 signals phase "over"
  if (roundPhase === "over" && roundNumber !== null) {
    completedRounds.add(roundNumber);
  }

  // Flush to disk on every write so data is safe if the server restarts
  writeFileSync(DEBUG_OUTPUT_FILE, JSON.stringify(debugPayloads, null, 2));

  // Check if we've seen enough complete rounds
  if (completedRounds.size >= DEBUG_ROUND_TARGET) {
    debugComplete = true;
    console.log("\n========================================================");
    console.log("  Debug completo - analise debug_payloads.json");
    console.log(`  Rounds capturados: ${[...completedRounds].sort((a, b) => a - b).join(", ")}`);
    console.log(`  Total de snapshots: ${debugPayloads.length}`);
    console.log("========================================================\n");
  }
}

// ---------------------------------------------------------------------------
// Server setup
// ---------------------------------------------------------------------------

const app = express();
const PORT = parseInt(process.env.GSI_PORT || "3000", 10);

// CS2 sends raw JSON in the POST body
app.use(express.json());

// ---------------------------------------------------------------------------
// GSI endpoint
// ---------------------------------------------------------------------------

/**
 * POST /gsi
 *
 * Receives a Game State Integration payload from CS2 and triggers the coaching
 * pipeline. CS2 polls this endpoint every ~100-250ms during a match, so the
 * handler responds immediately and processes asynchronously.
 * Heavy API work only fires when the throttle allows it.
 */
app.post("/gsi", async (req, res) => {
  // Always respond 200 immediately - CS2 does not wait for our processing
  res.sendStatus(200);

  const payload = req.body;

  // --- Debug collection (temporary) ---
  collectDebugPayload(payload);

  // Log incoming payload for live debugging
  console.log("[GSI] Payload recebido:", JSON.stringify(payload, null, 2).slice(0, 500));

  // Salva o ultimo payload completo em arquivo
  writeFileSync("last_payload.json", JSON.stringify(payload, null, 2));

  // Parse game state
  const gameState = parseGameState(payload);

  if (!gameState) {
    // Incomplete payload (e.g., main menu, loading screen, spectator mode)
    console.log("[GSI] parseGameState retornou null - payload incompleto");
    return;
  }

  // Enemy Coach pipeline
  try {
    const call = await generateEnemyCall(gameState);

    if (call) {
      // Forward the call to the bot execution layer
      await executeCall(call, gameState);
    }
  } catch (err) {
    console.error("[EnemyCoach] Error generating call:", (err && err.message) || err);
  }
});

// ---------------------------------------------------------------------------
// CSS (CounterStrikeSharp) endpoint
// ---------------------------------------------------------------------------

/**
 * POST /css-state
 *
 * Recebe o estado do jogo enviado pelo CS2AiCoachPlugin (C# / CounterStrikeSharp).
 * Substitui o /gsi em modo offline, onde `allplayers` não está disponível via GSI.
 *
 * O plugin C# envia dados a cada evento relevante:
 *   EventRoundStart | EventPlayerDeath | EventBombPlanted | EventBombDefused
 */
app.post("/css-state", async (req, res) => {
  // Responde imediatamente — o servidor de CS2 não aguarda nossa resposta
  res.sendStatus(200);

  const payload = req.body;

  console.log(
    "[CSS] Payload recebido:",
    JSON.stringify(payload, null, 2).slice(0, 500)
  );

  const gameState = parseCssState(payload);

  if (!gameState) {
    console.log("[CSS] parseCssState retornou null — payload incompleto");
    return;
  }

  try {
    const call = await generateEnemyCall(gameState);

    if (call) {
      await executeCall(call, gameState);
    }
  } catch (err) {
    console.error("[CSS] Erro ao gerar call:", (err && err.message) || err);
  }
});

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "cs2-ai-coach" });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

app.listen(PORT, () => {
  console.log("=============================================================");
  console.log("         CS2 AI Enemy Coach - Server Started                ");
  console.log("=============================================================");
  console.log("  GSI endpoint : http://localhost:" + PORT + "/gsi");
  console.log("  Health check : http://localhost:" + PORT + "/health");
  console.log("-------------------------------------------------------------");
  console.log("  [DEBUG] Coletando payloads de " + DEBUG_ROUND_TARGET + " rounds completos...");
  console.log("  [DEBUG] Saida: " + DEBUG_OUTPUT_FILE);
  console.log("=============================================================");
});
