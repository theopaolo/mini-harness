# Tool Benchmark — 2026-05-20

| Modèle                    | Score tools | Tool call | Bon outil | Args valides | No-tool | Final après outil | Parallèle | Latence |
| ------------------------- | ----------- | --------- | --------- | ------------ | ------- | ----------------- | --------- | ------- |
| ~moonshotai/kimi-latest   | 100%        | 100%      | 100%      | 100%         | 100%    | 100%              | 100%      | 11063ms |
| deepseek/deepseek-v4-pro  | 100%        | 100%      | 100%      | 100%         | 100%    | 100%              | 100%      | 5280ms  |
| moonshotai/kimi-k2.6      | 100%        | 100%      | 100%      | 100%         | 100%    | 100%              | 100%      | 2421ms  |
| qwen/qwen3-coder-next     | 100%        | 100%      | 100%      | 100%         | 100%    | 100%              | 100%      | 561ms   |
| qwen/qwen-2.5-7b-instruct | 0%          | 0%        | 0%        | 0%           | 0%      | 0%                | 0%        | 0ms     |

## Erreurs

- qwen/qwen-2.5-7b-instruct: OpenRouter 400: {"error":{"message":"Provider returned error","code":400,"metadata":{"raw":"{\"code\":400,\"msg\":\"bad request\",\"request_id\":\"55012249-fc9a-4faa-a6c6-841a3aa859e0\"}","provider_name":"AtlasCloud","is_byok":false}},"user_id":"user_2rDa2ai20sQDEbJpKcBWEGJRybt"}
