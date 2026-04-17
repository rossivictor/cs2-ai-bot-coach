# CS2 AI Enemy Coach

Um servidor Node.js local que lê o estado do jogo em tempo real via Game State Integration (GSI) do CS2 e usa Claude (Haiku 4.5) para gerar chamadas táticas para os bots inimigos. O objetivo é tornar o jogo offline genuinamente desafiador — bots com IGL de verdade, capazes de decidir entre executes, fakes, rotações e gestão de economia.

---

## Estrutura do repositório

```
cs2-ai-coach/
├── .env                          # Variáveis de ambiente (não versionado)
├── .env.example                  # Template de variáveis de ambiente
├── .gitignore
├── docker-compose.yml            # Orquestra cs2 + coach
├── README.md
│
├── services/
│   ├── coach/                    # Serviço Node.js (GSI + AI Coach)
│   │   ├── src/
│   │   │   ├── index.js          # Entry point / servidor Express
│   │   │   ├── gsi-parser.js     # Parser do Game State Integration
│   │   │   ├── css-parser.js     # Parser do payload do plugin C#
│   │   │   ├── enemy-coach.js    # IGL de IA (chamadas táticas via Claude)
│   │   │   └── bot-commander.js  # Injeção de comandos nos bots
│   │   ├── Dockerfile
│   │   ├── .dockerignore
│   │   ├── package.json
│   │   └── package-lock.json
│   │
│   └── cs2-plugin/               # Plugin CounterStrikeSharp (C#)
│       ├── src/
│       │   ├── CS2AiCoachPlugin.cs
│       │   └── Models/
│       │       └── PlayerState.cs
│       ├── CS2AiCoachPlugin.csproj
│       └── build.ps1             # Compila e copia a DLL para o container
│
└── config/
    ├── gamestate_integration_ai_coach.cfg  # Configuração GSI do CS2
    ├── gamemode_competitive_server.cfg     # Configuração de bots
    └── admins.json                         # Admins do CounterStrikeSharp
```

---

## Como funciona

```
CS2 (cliente)
    │  POST /gsi  (GSI, a cada ~250ms)
    ▼
Node.js server  ──►  Claude Haiku 4.5  ──►  chamada tática no terminal
    ▲
    │  POST /css-state  (eventos de jogo)
CS2 Dedicated Server (Docker)
    └── CounterStrikeSharp plugin (CS2AiCoachPlugin.dll)
```

O fluxo tem dois caminhos paralelos:

**GSI (cliente CS2 → Node):** O CS2 envia o estado global do jogo a cada ciclo. O `gsi-parser.js` extrai os dados relevantes. O `enemy-coach.js` monta um prompt tático e chama a API da Anthropic com streaming, imprimindo a call no terminal em tempo real.

**CSS Plugin (servidor Docker → Node):** O `CS2AiCoachPlugin` (C# / CounterStrikeSharp) roda no servidor dedicado e envia o estado dos jogadores ao endpoint `/css-state` a cada evento relevante (início de round, morte, bomba plantada/desarmada). Isso supre o `allplayers` que o GSI omite em servidores locais.

As calls geradas chegam ao `bot-commander.js`, que atualmente as registra no terminal. A injeção de comandos nos bots via CounterStrikeSharp está em desenvolvimento (Fase 2).

---

## Pré-requisitos

- **Docker Desktop** — para o servidor dedicado de CS2
- **Node.js v22+** — o servidor GSI
- **.NET SDK 8** — para compilar o plugin C#
- **Counter-Strike 2** instalado via Steam
- **API Key da Anthropic** — obtenha em [console.anthropic.com](https://console.anthropic.com)
- **Game Server Login Token (GSLT)** — necessário para rodar o servidor dedicado; crie em [steamcommunity.com/dev/managegameservers](https://steamcommunity.com/dev/managegameservers) com AppID `730`

> **Atenção:** O servidor dedicado de CS2 ocupa aproximadamente **60 GB** em disco. Certifique-se de ter espaço disponível antes de continuar.

---

## Instalação

> O repositório já foi clonado. Siga os passos abaixo a partir da raiz do projeto.

### 1. Configurar as variáveis de ambiente

Copie o arquivo de exemplo e preencha com suas chaves:

```bash
cp .env.example .env
```

Edite o `.env`:

```env
ANTHROPIC_API_KEY=sk-ant-api03-...   # sua chave da Anthropic
SRCDS_TOKEN=...                      # seu Game Server Login Token
GSI_PORT=3000
```

### 2. Instalar dependências Node.js

```bash
cd services/coach
npm install
```

### 3. Configurar o endereço no GSI

O CS2 precisa saber para qual IP enviar os dados. Descubra o IP local da sua máquina Windows:

```powershell
ipconfig
# Procure pelo endereço IPv4 em "Adaptador de Rede sem Fio" ou "Ethernet"
# Exemplo: 192.168.15.4
```

Abra `config/gamestate_integration_ai_coach.cfg` e atualize a linha `uri`:

```
"uri"  "http://SEU_IP_LOCAL:3000/gsi"
```

### 4. Compilar o plugin C#

```powershell
cd services/cs2-plugin
dotnet build -c Release
```

O binário gerado fica em `services/cs2-plugin/src/bin/Release/net8.0/CS2AiCoachPlugin.dll`.

### 5. Subir o servidor CS2 no Docker

Na raiz do projeto:

```bash
docker-compose up -d
```

> **Primeiro boot:** o container vai baixar o servidor dedicado de CS2 (~60 GB via SteamCMD). Aguarde a conclusão — pode levar bastante tempo dependendo da sua conexão.

Acompanhe os logs:

```bash
docker-compose logs -f
```

### 6. Copiar arquivos para dentro do container

Com o servidor rodando, copie os arquivos de configuração:

```bash
# Configuração do GSI
docker cp config/gamestate_integration_ai_coach.cfg \
  cs2-ai-coach-server:/home/steam/cs2-dedicated/game/csgo/cfg/

# Configuração dos bots
docker cp config/gamemode_competitive_server.cfg \
  cs2-ai-coach-server:/home/steam/cs2-dedicated/game/csgo/cfg/
```

Para compilar e copiar o plugin automaticamente, use o script PowerShell:

```powershell
cd services/cs2-plugin
.\build.ps1
```

### 7. Configurar admin do CounterStrikeSharp

Edite `config/admins.json` com seu SteamID64 (encontre o seu em [steamid.io](https://steamid.io)):

```json
{
  "seu_nome": {
    "identity": "76561198XXXXXXXXX",
    "flags": ["@css/root"]
  }
}
```

Copie para o container:

```bash
docker cp config/admins.json \
  cs2-ai-coach-server:/home/steam/cs2-dedicated/game/csgo/addons/counterstrikesharp/configs/admins.json
```

### 8. Adicionar launch option no CS2

No Steam, vá em CS2 → Propriedades → Opções de inicialização e adicione:

```
-gamestateintegration
```

---

## Uso

### Rotina diária

**1. Subir o servidor CS2 (raiz do projeto):**

```bash
docker-compose up -d
```

**2. Iniciar o servidor Node.js:**

```bash
cd services/coach
npm start
```

**3. Conectar no CS2:**

Abra o console do CS2 (`~`) e execute:

```
connect 127.0.0.1
```

As chamadas táticas do Claude aparecerão no terminal do Node.js em tempo real, a cada mudança de fase do round.

---

## Verificações

Após conectar ao servidor, confirme que tudo está funcionando via console do CS2:

```
meta version          # verifica se o Metamod está ativo
css_plugins list      # lista os plugins do CounterStrikeSharp carregados
```

O plugin `CS2 AI Coach Plugin` deve aparecer na listagem.

No terminal do Node.js, você deve ver payloads chegando via `/gsi` e `/css-state` assim que a partida começa.

---

## Estado atual

**Funcionando:**

- Leitura de game state via GSI (cliente CS2)
- Leitura de game state via plugin C# (servidor dedicado)
- Geração de calls táticas com Claude Haiku 4.5 (streaming no terminal)
- Throttle por (round, fase) para evitar chamadas duplicadas à API
- Coleta de debug payloads para os primeiros 3 rounds (`debug_payloads.json`)

**Em desenvolvimento (Fase 2):**

- Injeção de comandos nos bots via CounterStrikeSharp — o `bot-commander.js` atualmente só registra as calls no terminal; a execução real via servidor ainda está sendo implementada

---

## Licença

MIT
