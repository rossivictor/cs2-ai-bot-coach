using System.Text.Json.Serialization;

namespace CS2AiCoachPlugin.Models;

/// <summary>
/// Payload completo enviado ao servidor Node.js a cada evento de jogo.
/// </summary>
public class GameStatePayload
{
    /// <summary>Tipo de evento que disparou o envio (round_start, player_death, etc.).</summary>
    [JsonPropertyName("event")]
    public string Event { get; set; } = "";

    /// <summary>Número do round atual (TotalRoundsPlayed + 1).</summary>
    [JsonPropertyName("round")]
    public int Round { get; set; }

    /// <summary>Fase do round: "freezetime", "live", "warmup" ou "unknown".</summary>
    [JsonPropertyName("phase")]
    public string Phase { get; set; } = "";

    /// <summary>Nome do mapa atual (ex: "de_dust2").</summary>
    [JsonPropertyName("map")]
    public string Map { get; set; } = "";

    /// <summary>Lista com o estado de todos os jogadores conectados.</summary>
    [JsonPropertyName("players")]
    public List<PlayerState> Players { get; set; } = new();
}

/// <summary>
/// Estado de um jogador individual no momento do evento.
/// </summary>
public class PlayerState
{
    /// <summary>Nome em jogo do jogador.</summary>
    [JsonPropertyName("name")]
    public string Name { get; set; } = "";

    /// <summary>Steam ID do jogador, ou "BOT" para bots.</summary>
    [JsonPropertyName("steamId")]
    public string SteamId { get; set; } = "";

    /// <summary>Time: "T", "CT" ou "Spectator".</summary>
    [JsonPropertyName("team")]
    public string Team { get; set; } = "";

    /// <summary>Indica se o jogador está vivo (health > 0).</summary>
    [JsonPropertyName("alive")]
    public bool Alive { get; set; }

    /// <summary>HP atual do jogador (0-100).</summary>
    [JsonPropertyName("health")]
    public int Health { get; set; }

    /// <summary>Dinheiro disponível no momento do evento.</summary>
    [JsonPropertyName("money")]
    public int Money { get; set; }

    /// <summary>Armas no inventário (ex: ["ak47", "glock", "he_grenade"]).</summary>
    [JsonPropertyName("weapons")]
    public List<string> Weapons { get; set; } = new();

    /// <summary>Posição 3D do jogador no mundo. Null se o jogador estiver morto.</summary>
    [JsonPropertyName("position")]
    public PositionState? Position { get; set; }
}

/// <summary>
/// Coordenadas 3D no espaço de jogo do CS2.
/// </summary>
public class PositionState
{
    [JsonPropertyName("x")]
    public float X { get; set; }

    [JsonPropertyName("y")]
    public float Y { get; set; }

    [JsonPropertyName("z")]
    public float Z { get; set; }
}
