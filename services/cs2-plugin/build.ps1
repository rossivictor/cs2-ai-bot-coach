dotnet build -c Release
docker cp src/bin/Release/net8.0/CS2AiCoachPlugin.dll cs2-ai-coach-server:/home/steam/cs2-dedicated/game/csgo/addons/counterstrikesharp/plugins/CS2AiCoachPlugin/
docker cp src/bin/Release/net8.0/CS2AiCoachPlugin.deps.json cs2-ai-coach-server:/home/steam/cs2-dedicated/game/csgo/addons/counterstrikesharp/plugins/CS2AiCoachPlugin/
