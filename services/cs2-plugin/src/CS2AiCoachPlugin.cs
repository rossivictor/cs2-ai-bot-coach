using CounterStrikeSharp.API;
using CounterStrikeSharp.API.Core;
using CounterStrikeSharp.API.Core.Attributes;
using CounterStrikeSharp.API.Modules.Utils;
using CS2AiCoachPlugin.Models;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace CS2AiCoachPlugin;

// ---------------------------------------------------------------------------
// Plugin Configuration
// ---------------------------------------------------------------------------

/// <summary>
/// Configuração persistida em CS2AiCoachPlugin.json dentro da pasta do plugin.
/// Edite esse arquivo para apontar para um servidor diferente sem recompilar.
/// </summary>
public class PluginConfig : BasePluginConfig
{
    /// <summary>
    /// URL do endpoint Node.js que receberá o estado do jogo.
    /// Padrão: http://coach:3000/css-state → funciona dentro do Docker Compose
    /// (serviço "coach" na rede coach-network). Troque por "localhost" se
    /// ambos rodarem fora do Docker.
    /// </summary>
    [JsonPropertyName("NodeServerUrl")]
    public string NodeServerUrl { get; set; } = "http://coach:3000/css-state";

    /// <summary>
    /// Porta em que o plugin escuta comandos vindos do Node.js.
    /// </summary>
    [JsonPropertyName("CommandListenerPort")]
    public int CommandListenerPort { get; set; } = 27016;
}

// ---------------------------------------------------------------------------
// Bot Command model (recebido do Node.js)
// ---------------------------------------------------------------------------

/// <summary>
/// Payload enviado pelo bot-commander.js via POST /bot-command.
/// </summary>
public class BotCommand
{
    /// <summary>Texto livre da call gerada pelo Claude.</summary>
    [JsonPropertyName("call")]
    public string Call { get; set; } = "";

    /// <summary>"T" ou "CT" — lado cujos bots devem receber o comando.</summary>
    [JsonPropertyName("side")]
    public string Side { get; set; } = "T";

    /// <summary>Ação estruturada: rush_b | rush_a | force_b | save | default.</summary>
    [JsonPropertyName("action")]
    public string Action { get; set; } = "default";
}

// ---------------------------------------------------------------------------
// Plugin Principal
// ---------------------------------------------------------------------------

[MinimumApiVersion(200)]
public class CS2AiCoachPlugin : BasePlugin, IPluginConfig<PluginConfig>
{
    public override string ModuleName        => "CS2 AI Coach Plugin";
    public override string ModuleVersion     => "1.1.0";
    public override string ModuleAuthor      => "Victor";
    public override string ModuleDescription => "Coleta estado dos jogadores, envia ao Node.js e recebe comandos para injetar nos bots.";

    // HttpClient estático: evita socket exhaustion — NÃO crie um por requisição.
    private static readonly HttpClient _http = new HttpClient
    {
        Timeout = TimeSpan.FromSeconds(5)
    };

    private static readonly JsonSerializerOptions _jsonOptions = new JsonSerializerOptions
    {
        PropertyNamingPolicy        = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition      = JsonIgnoreCondition.WhenWritingNull,
        PropertyNameCaseInsensitive = true
    };

    // Servidor HTTP de comandos (recebe calls do Node.js)
    private HttpListener? _commandListener;
    private Thread?       _commandThread;
    private CancellationTokenSource _cts = new();

    // Config injetada pelo CSS após carregar o JSON
    public PluginConfig Config { get; set; } = new();

    public void OnConfigParsed(PluginConfig config)
    {
        Config = config;
        Console.WriteLine($"[CS2AiCoachPlugin] NodeServerUrl configurado: {Config.NodeServerUrl}");
        Console.WriteLine($"[CS2AiCoachPlugin] CommandListenerPort: {Config.CommandListenerPort}");
    }

    // ---------------------------------------------------------------------------
    // Carregamento / Descarregamento
    // ---------------------------------------------------------------------------

    public override void Load(bool hotReload)
    {
        RegisterEventHandler<EventRoundStart>(OnRoundStart);
        RegisterEventHandler<EventPlayerDeath>(OnPlayerDeath);
        RegisterEventHandler<EventBombPlanted>(OnBombPlanted);
        RegisterEventHandler<EventBombDefused>(OnBombDefused);

        StartCommandListener();

        Console.WriteLine($"[CS2AiCoachPlugin] Plugin carregado v{ModuleVersion}.");
        Console.WriteLine($"[CS2AiCoachPlugin] Enviando estados para: {Config.NodeServerUrl}");
        Console.WriteLine($"[CS2AiCoachPlugin] Recebendo comandos em: http://*:{Config.CommandListenerPort}/bot-command");
    }

    public override void Unload(bool hotReload)
    {
        _cts.Cancel();
        try { _commandListener?.Stop(); } catch { /* já parado */ }
        _commandThread?.Join(TimeSpan.FromSeconds(2));
        Console.WriteLine("[CS2AiCoachPlugin] Plugin descarregado, listener HTTP encerrado.");
    }

    // ---------------------------------------------------------------------------
    // Servidor HTTP de comandos (thread separada — fora do game thread)
    // ---------------------------------------------------------------------------

    private void StartCommandListener()
    {
        try
        {
            _commandListener = new HttpListener();
            _commandListener.Prefixes.Add($"http://*:{Config.CommandListenerPort}/");
            _commandListener.Start();

            _commandThread = new Thread(() =>
            {
                Console.WriteLine($"[CS2AiCoachPlugin] Command listener iniciado na porta {Config.CommandListenerPort}");

                while (!_cts.IsCancellationRequested && _commandListener.IsListening)
                {
                    try
                    {
                        // Bloqueia até chegar uma requisição
                        var context = _commandListener.GetContext();
                        // Processa em thread pool — não bloqueia o listener
                        _ = Task.Run(() => HandleBotCommandAsync(context));
                    }
                    catch (HttpListenerException)
                    {
                        // Listener foi parado intencionalmente (Unload)
                        break;
                    }
                    catch (ObjectDisposedException)
                    {
                        break;
                    }
                    catch (Exception ex)
                    {
                        Console.WriteLine($"[CS2AiCoachPlugin] Erro no command listener: {ex.Message}");
                    }
                }

                Console.WriteLine("[CS2AiCoachPlugin] Command listener encerrado.");
            });

            _commandThread.IsBackground = true;
            _commandThread.Name = "CS2AiCoach-CommandListener";
            _commandThread.Start();
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[CS2AiCoachPlugin] ERRO ao iniciar command listener: {ex.Message}");
            Console.WriteLine($"[CS2AiCoachPlugin] Certifique-se de que a porta {Config.CommandListenerPort} está disponível.");
        }
    }

    /// <summary>
    /// Processa uma requisição POST /bot-command recebida do Node.js.
    /// Roda na thread pool — toda interação com a API do CS2 deve ir via Server.NextFrame().
    /// </summary>
    private async Task HandleBotCommandAsync(HttpListenerContext context)
    {
        var req = context.Request;
        var res = context.Response;

        try
        {
            // Só aceita POST /bot-command
            if (req.HttpMethod != "POST" || req.Url?.LocalPath.TrimEnd('/') != "/bot-command")
            {
                res.StatusCode = 404;
                res.Close();
                return;
            }

            // Lê o body
            using var reader = new StreamReader(req.InputStream, Encoding.UTF8);
            var body = await reader.ReadToEndAsync();

            BotCommand? cmd = null;
            try
            {
                cmd = JsonSerializer.Deserialize<BotCommand>(body, _jsonOptions);
            }
            catch (JsonException ex)
            {
                Console.WriteLine($"[CS2AiCoachPlugin] JSON inválido em /bot-command: {ex.Message}");
                res.StatusCode = 400;
                res.Close();
                return;
            }

            if (cmd == null)
            {
                res.StatusCode = 400;
                res.Close();
                return;
            }

            Console.WriteLine($"[CS2AiCoachPlugin] <- Comando recebido: side={cmd.Side} action={cmd.Action} call=\"{cmd.Call}\"");

            // Toda interação com a API do CS2 DEVE estar dentro de Server.NextFrame()
            Server.NextFrame(() => ExecuteBotCommand(cmd));

            // Responde 200 imediatamente (não espera o NextFrame)
            res.StatusCode = 200;
            var responseBytes = Encoding.UTF8.GetBytes("ok");
            res.ContentLength64 = responseBytes.Length;
            await res.OutputStream.WriteAsync(responseBytes);
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[CS2AiCoachPlugin] Erro ao processar /bot-command: {ex.Message}");
            try { res.StatusCode = 500; } catch { /* response já fechada */ }
        }
        finally
        {
            try { res.Close(); } catch { /* ignorar */ }
        }
    }

    /// <summary>
    /// Executa o comando recebido do Node.js nos bots do lado indicado.
    /// Roda dentro de Server.NextFrame() — acesso seguro à API do CS2.
    /// </summary>
    private void ExecuteBotCommand(BotCommand cmd)
    {
        try
        {
            Console.WriteLine($"[CS2AiCoachPlugin] Executando acao '{cmd.Action}' para bots do time {cmd.Side}.");

            string? consoleCommand = cmd.Action switch
            {
                "rush_b"  => "bot_place bombsite_b",
                "rush_a"  => "bot_place bombsite_a",
                "force_b" => "bot_place bombsite_b",
                "save"    => null,
                _         => null,
            };

            if (consoleCommand != null)
            {
                Server.ExecuteCommand(consoleCommand);
                Console.WriteLine($"[CS2AiCoachPlugin] Comando executado: '{consoleCommand}'");
            }
            else
            {
                Console.WriteLine($"[CS2AiCoachPlugin] Acao '{cmd.Action}' sem comando direto, bots continuam com IA padrao.");
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[CS2AiCoachPlugin] Erro ao executar comando nos bots: {ex.Message}");
        }
    }

    // ---------------------------------------------------------------------------
    // Coleta e envio de estado do jogo
    // ---------------------------------------------------------------------------

    /// <summary>
    /// Coleta o estado atual de todos os jogadores e envia ao servidor Node.js.
    /// </summary>
    private void SendGameState(string eventName, string phase)
    {
        try
        {
            var playerStates = Utilities.GetAllPlayers()
                .Where(p => p.IsValid && !p.IsHLTV &&
                            (p.Team == CsTeam.Terrorist || p.Team == CsTeam.CounterTerrorist))
                .Select(p =>
                {
                    var pawn = p.PlayerPawn.Value;
                    return new PlayerState
                    {
                        Name    = p.PlayerName,
                        SteamId = p.IsBot ? "BOT" : p.SteamID.ToString(),
                        Team    = p.Team == CsTeam.Terrorist ? "T" : "CT",
                        Alive   = p.PawnIsAlive,
                        Health  = pawn?.Health ?? 0,
                        Money   = p.InGameMoneyServices?.Account ?? 0,
                        Weapons = pawn?.WeaponServices?.MyWeapons
                                      .Where(w => w.Value != null)
                                      .Select(w => w.Value!.DesignerName?.Replace("weapon_", "") ?? "")
                                      .Where(w => !string.IsNullOrEmpty(w))
                                      .ToList() ?? new List<string>(),
                        Position = p.PawnIsAlive && pawn?.AbsOrigin != null
                            ? new PositionState { X = pawn.AbsOrigin.X, Y = pawn.AbsOrigin.Y, Z = pawn.AbsOrigin.Z }
                            : null,
                    };
                })
                .ToList();

            var gameRules = Utilities.FindAllEntitiesByDesignerName<CCSGameRules>("cs_gamerules")
                                     .FirstOrDefault();
            int roundNumber = gameRules?.TotalRoundsPlayed ?? 0;

            var payload = new GameStatePayload
            {
                Event   = eventName,
                Round   = roundNumber,
                Phase   = phase,
                Map     = Server.MapName,
                Players = playerStates,
            };

            _ = PostGameStateAsync(payload);
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[CS2AiCoachPlugin] Erro ao coletar estado do jogo: {ex.Message}");
        }
    }

    /// <summary>
    /// Serializa e envia o payload ao servidor Node.js de forma assincrona (fire-and-forget).
    /// </summary>
    private async Task PostGameStateAsync(GameStatePayload payload)
    {
        try
        {
            var json     = JsonSerializer.Serialize(payload, _jsonOptions);
            var content  = new StringContent(json, Encoding.UTF8, "application/json");
            var response = await _http.PostAsync(Config.NodeServerUrl, content);

            if (!response.IsSuccessStatusCode)
                Console.WriteLine($"[CS2AiCoachPlugin] Node.js retornou HTTP {(int)response.StatusCode}");
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[CS2AiCoachPlugin] Erro ao enviar estado para Node.js: {ex.Message}");
        }
    }

    // ---------------------------------------------------------------------------
    // Handlers de eventos
    // ---------------------------------------------------------------------------

    private HookResult OnRoundStart(EventRoundStart @event, GameEventInfo info)
    {
        SendGameState("round_start", "freezetime");
        return HookResult.Continue;
    }

    private HookResult OnPlayerDeath(EventPlayerDeath @event, GameEventInfo info)
    {
        SendGameState("player_death", "live");
        return HookResult.Continue;
    }

    private HookResult OnBombPlanted(EventBombPlanted @event, GameEventInfo info)
    {
        SendGameState("bomb_planted", "live");
        return HookResult.Continue;
    }

    private HookResult OnBombDefused(EventBombDefused @event, GameEventInfo info)
    {
        SendGameState("bomb_defused", "live");
        return HookResult.Continue;
    }
}
