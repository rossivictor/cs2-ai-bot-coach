/**
 * css-parser.js
 *
 * Converte payloads enviados pelo CS2AiCoachPlugin (CounterStrikeSharp) para a
 * mesma estrutura de GameState usada pelo gsi-parser.js.
 *
 * Usado como substituto do GSI em modo offline / com bots, onde o campo
 * `allplayers` não está disponível via Game State Integration padrão.
 *
 * Formato de entrada esperado:
 * {
 *   "event":   "round_start",
 *   "round":   5,
 *   "phase":   "live",
 *   "map":     "de_dust2",
 *   "players": [
 *     {
 *       "name":     "Bot1",
 *       "steamId":  "BOT",
 *       "team":     "T",
 *       "alive":    true,
 *       "health":   100,
 *       "money":    3200,
 *       "weapons":  ["ak47", "glock"],
 *       "position": { "x": 100, "y": 200, "z": 0 }
 *     }
 *   ]
 * }
 */

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

const TEAM_CT = "CT";
const TEAM_T  = "T";

const BUY_TYPE_THRESHOLDS = {
  eco:   2000,
  force: 3500,
  semi:  5000,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function classifyEconomy(totalMoney) {
  if (totalMoney < BUY_TYPE_THRESHOLDS.eco)   return "eco";
  if (totalMoney < BUY_TYPE_THRESHOLDS.force)  return "force";
  if (totalMoney < BUY_TYPE_THRESHOLDS.semi)   return "semi";
  return "full-buy";
}

function buildTeamState(side, players) {
  const alivePlayers = players.filter((p) => p.alive);
  const totalMoney   = players.reduce((sum, p) => sum + (p.money || 0), 0);

  return {
    side,
    players,
    alivePlayers,
    aliveCount: alivePlayers.length,
    totalMoney,
    economy: classifyEconomy(totalMoney),
  };
}

/**
 * Identifica o lado do jogador humano (steam ID real, não "BOT").
 * Se todos forem bots (sessão puramente offline), retorna null para que o
 * chamador decida o comportamento.
 *
 * @param {Array} players - Lista de jogadores do payload CSS.
 * @returns {"T"|"CT"|null}
 */
function resolveHumanSide(players) {
  const human = players.find(
    (p) => p.steamId && p.steamId !== "BOT" && (p.team === TEAM_T || p.team === TEAM_CT)
  );
  return human ? human.team : null;
}

// ---------------------------------------------------------------------------
// Parser principal
// ---------------------------------------------------------------------------

/**
 * Converte um payload do CS2AiCoachPlugin em um GameState compatível com
 * generateEnemyCall() em enemy-coach.js.
 *
 * @param {object} payload - Corpo JSON recebido no endpoint /css-state.
 * @returns {object|null} GameState estruturado, ou null se inválido.
 */
export function parseCssState(payload) {
  if (!payload || !Array.isArray(payload.players) || payload.players.length === 0) {
    console.log("[CssParser] Payload inválido ou sem jogadores — ignorando");
    return null;
  }

  // Determina lado do humano
  let humanSide = resolveHumanSide(payload.players);

  if (!humanSide) {
    // Sessão apenas com bots: escolhe CT como lado "humano" por padrão,
    // assim o coach trabalha os inimigos T normalmente.
    console.log("[CssParser] Nenhum jogador humano encontrado — usando CT como padrão");
    humanSide = TEAM_CT;
  }

  const enemySide = humanSide === TEAM_CT ? TEAM_T : TEAM_CT;

  // Normaliza jogadores para o formato esperado pelo enemy-coach
  const normalize = (p) => ({
    name:     p.name    || "Unknown",
    steamId:  p.steamId || "BOT",
    alive:    Boolean(p.alive),
    money:    p.money   || 0,
    weapons:  Array.isArray(p.weapons) ? p.weapons : [],
    position: p.position || null,
  });

  const humanPlayers = payload.players
    .filter((p) => p.team === humanSide)
    .map(normalize);

  const enemyPlayers = payload.players
    .filter((p) => p.team === enemySide)
    .map(normalize);

  const humanTeam = buildTeamState(humanSide, humanPlayers);
  const enemyTeam = buildTeamState(enemySide, enemyPlayers);

  return {
    mapName:      payload.map      || "unknown",
    roundNumber:  payload.round    || 0,
    roundPhase:   payload.phase    || "unknown",
    roundWinTeam: null,
    bomb: { state: "unknown", position: null, countdown: null, player: null },
    humanSide,
    enemySide,
    humanTeam,
    enemyTeam,
    _raw: payload,
  };
}
