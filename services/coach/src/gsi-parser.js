/**
 * gsi-parser.js
 *
 * Parses raw CS2 Game State Integration (GSI) payloads and exposes a clean,
 * structured game state with explicit humanSide and enemySide separations.
 *
 * CS2 GSI reference:
 *   https://developer.valvesoftware.com/wiki/CS2_Game_State_Integration
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEAM_CT = "CT";
const TEAM_T = "T";

const BUY_TYPE_THRESHOLDS = {
  eco: 2000,
  force: 3500,
  semi: 5000,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function classifyEconomy(totalMoney) {
  if (totalMoney < BUY_TYPE_THRESHOLDS.eco) return "eco";
  if (totalMoney < BUY_TYPE_THRESHOLDS.force) return "force";
  if (totalMoney < BUY_TYPE_THRESHOLDS.semi) return "semi";
  return "full-buy";
}

function extractTeamPlayers(allplayers, teamSide) {
  if (!allplayers) return [];

  return Object.entries(allplayers)
    .filter(([, player]) => player && player.team === teamSide)
    .map(([steamId, player]) => {
      const alive = player.state && player.state.health > 0;
      const money = (player.state && player.state.money) || 0;

      const weapons = player.weapons
        ? Object.values(player.weapons)
            .map((w) => (w && w.name ? w.name.replace("weapon_", "") : "unknown"))
            .filter(Boolean)
        : [];

      return {
        name: player.name || "Unknown",
        steamId,
        alive,
        money,
        weapons,
        position: player.position || null,
      };
    });
}

function buildTeamState(side, players) {
  const alivePlayers = players.filter((p) => p.alive);
  const totalMoney = players.reduce((sum, p) => sum + p.money, 0);

  return {
    side,
    players,
    alivePlayers,
    aliveCount: alivePlayers.length,
    totalMoney,
    economy: classifyEconomy(totalMoney),
  };
}

// ---------------------------------------------------------------------------
// Human SteamID resolution
//
// CS2 GSI always sends `provider.steamid` = the human's Steam ID.
// When the human is alive:   player.steamid === provider.steamid
// When the human is dead:    player.steamid = the spectated bot's ID (unreliable)
//
// Strategy: use provider.steamid to look up the human's team in allplayers.
// Fall back to player.team only if allplayers is absent (heartbeat-only ticks).
// ---------------------------------------------------------------------------

function resolveHumanSide(payload) {
  const providerSteamId = payload.provider && payload.provider.steamid;
  const allplayers = payload.allplayers;

  // Primary: match provider SteamID against allplayers (works dead or alive)
  if (providerSteamId && allplayers && allplayers[providerSteamId]) {
    const team = allplayers[providerSteamId].team;
    if (team === TEAM_CT || team === TEAM_T) return team;
  }

  // Secondary: use player.team only if it belongs to the actual human
  // Guard against the "spectating a bot" case by checking SteamID length
  // (real Steam IDs are 17 digits; bot IDs in CS2 GSI are short integers)
  const playerSteamId = payload.player && payload.player.steamid;
  const playerTeam = payload.player && payload.player.team;
  if (playerSteamId && String(playerSteamId).length === 17 && (playerTeam === TEAM_CT || playerTeam === TEAM_T)) {
    return playerTeam;
  }

  // Tertiary: previously field (populated between ticks)
  const prevTeam = payload.previously && payload.previously.player && payload.previously.player.team;
  if (prevTeam === TEAM_CT || prevTeam === TEAM_T) return prevTeam;

  return null;
}

// ---------------------------------------------------------------------------
// Main parser
// ---------------------------------------------------------------------------

/**
 * Parses a raw CS2 GSI payload and returns a structured GameState.
 *
 * @param {object} payload - Raw JSON body from the GSI HTTP POST.
 * @returns {object|null} Parsed state, or null if the payload is too incomplete.
 */
export function parseGameState(payload) {
  if (!payload || !payload.map) {
    console.log("[Parser] Payload sem map — ignorando");
    return null;
  }

  const mapName    = (payload.map && payload.map.name)  || "unknown";
  const roundNumber = payload.map.round ?? 0;
  const roundPhase  = (payload.round && payload.round.phase) || payload.map.phase || "unknown";
  const roundWinTeam = (payload.round && payload.round.win_team) || null;

  // Bomb state
  const bombState = payload.bomb || null;
  const bomb = bombState
    ? {
        state:     bombState.state    || "unknown",
        position:  bombState.position || null,
        countdown: bombState.countdown || null,
        player:    bombState.player   || null,
      }
    : { state: "unknown", position: null, countdown: null, player: null };

  // Resolve which side the human is on
  const humanSide = resolveHumanSide(payload);

  if (!humanSide) {
    console.log("[Parser] Lado do humano nao identificavel — player.steamid:",
      payload.player && payload.player.steamid,
      "| allplayers keys:", Object.keys(payload.allplayers || {}).length
    );
    return null;
  }

  const enemySide = humanSide === TEAM_CT ? TEAM_T : TEAM_CT;

  const allplayers = payload.allplayers || {};
  const humanTeam  = buildTeamState(humanSide, extractTeamPlayers(allplayers, humanSide));
  const enemyTeam  = buildTeamState(enemySide, extractTeamPlayers(allplayers, enemySide));

  // Warn when allplayers is missing (GSI config issue)
  if (Object.keys(allplayers).length === 0) {
    console.warn("[Parser] AVISO: allplayers vazio — verifique o gamestate_integration_ai_coach.cfg");
  }

  return {
    mapName,
    roundNumber,
    roundPhase,
    roundWinTeam,
    bomb,
    humanSide,
    enemySide,
    humanTeam,
    enemyTeam,
    _raw: payload,
  };
}
