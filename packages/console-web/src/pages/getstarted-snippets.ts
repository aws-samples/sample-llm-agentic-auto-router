// Get started snippet templates (4f §6; frontend templates, not copy: comments stay in English in both languages,
// as in the README). Values come from /api/me/setup. Placeholders for missing values stay visible ('<…>').

import type { SetupInfo } from '@auto-router/console-contract'

export interface SnippetValues {
  inferenceUrl: string
  authorizeEndpoint: string
  tokenEndpoint: string
  clientId: string
  scope: string
  codexOauthPort: string
  configureJson: string
  cliRawUrl: string
}

/** Placeholder names for values this deployment should provide (Get started explains them as missing settings). */
export const CLI_RAW_URL_PLACEHOLDER = 'raw URL of tools/llmar/llmar in your copy of the repository'
export const DEPLOYMENT_PLACEHOLDERS: ReadonlySet<string> = new Set(['inference URL', 'authorize endpoint', 'token endpoint',
  'cli client id', 'scope', 'Codex callback port', 'configure JSON', CLI_RAW_URL_PLACEHOLDER])
/** Codex expands ~ in catalog paths, but runs the auth command without shell expansion. */
export const CODEX_AUTH_PATH_FIX = `python3 -c 'import json; from pathlib import Path; p = Path.home() / ".codex/config.toml"; s = p.read_text(); p.write_text(s.replace("command = \\"~/bin/llmar-token\\"", "command = " + json.dumps(str(Path.home() / "bin/llmar-token"))))'`
/** The same for Windows: the config is saved with %USERPROFILE% in its two paths; this writes the real folder (UTF-8, as TOML requires). */
export const CODEX_AUTH_PATH_FIX_WINDOWS = `python -c @'
from pathlib import Path
p = Path.home() / '.codex' / 'config.toml'
p.write_text(p.read_text(encoding='utf-8').replace('%USERPROFILE%', str(Path.home())), encoding='utf-8')
'@`
/** Window Claude Code assumes for 'auto' (it assumes 200K for ids it does not know): the default Claude pool is all 1M. */
export const CLAUDE_CONTEXT_TOKENS = '1000000'

const or = (v: string | number | undefined, name: string) => (v === undefined || v === '' ? `<${name}>` : String(v))

/** Single-quoted shell argument. */
export const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

/** Where the snippets run: 'windows' is native Windows in PowerShell. WSL follows 'unix'. */
export type Platform = 'unix' | 'windows'
export const detectPlatform = (userAgent: string): Platform => (/Windows/i.test(userAgent) ? 'windows' : 'unix')

/** Single-quoted PowerShell string. */
export const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`

export function snippetValues(s: SetupInfo, cliRawUrl: string | undefined): SnippetValues {
  return {
    inferenceUrl: or(s.inferenceUrl, 'inference URL'),
    authorizeEndpoint: or(s.authorizeEndpoint, 'authorize endpoint'),
    tokenEndpoint: or(s.tokenEndpoint, 'token endpoint'),
    clientId: or(s.clientId, 'cli client id'),
    scope: or(s.scope, 'scope'),
    codexOauthPort: or(s.codexOauthPort, 'Codex callback port'),
    configureJson: s.configureJson ? JSON.stringify(s.configureJson) : '<configure JSON>',
    cliRawUrl: cliRawUrl ?? `<${CLI_RAW_URL_PLACEHOLDER}>`,
  }
}

export const install = (v: SnippetValues) => `mkdir -p ~/bin
curl -fsSLo ~/bin/llmar ${shellQuote(v.cliRawUrl)} && chmod +x ~/bin/llmar
ln -sf llmar ~/bin/llmar-token && ln -sf llmar ~/bin/llmar-login`

/**
 * Windows has no symlinks without extra rights and does not run a file by its shebang: three .cmd files next to the
 * script are llmar, llmar-token and llmar-login (cmd, PowerShell, Claude Code and Codex all run .cmd files).
 * curl.exe, not curl: in Windows PowerShell 5.1 `curl` is an alias of Invoke-WebRequest. Set-Content writes no BOM.
 */
export const installWindows = (v: SnippetValues) => `$bin = "$HOME\\bin"
New-Item -ItemType Directory -Force $bin | Out-Null
curl.exe -fsSLo "$bin\\llmar" ${psQuote(v.cliRawUrl)}
Set-Content "$bin\\llmar.cmd"       '@python "%~dp0llmar" %*'
Set-Content "$bin\\llmar-token.cmd" '@python "%~dp0llmar" token %*'
Set-Content "$bin\\llmar-login.cmd" '@python "%~dp0llmar" login %*'
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')   # add the folder to your PATH, once
if (($userPath -split ';') -notcontains $bin) { [Environment]::SetEnvironmentVariable('Path', "$userPath;$bin", 'User'); $env:Path += ";$bin" }`

export const configure = (v: SnippetValues) => `llmar configure --from ${shellQuote(v.configureJson)}`

/** PowerShell drops the double quotes of a JSON argument on the way to a .cmd file, so the block goes in on stdin. */
export const configureWindows = (v: SnippetValues) => `@'
${v.configureJson}
'@ | llmar configure --from -`

export const signIn = () => `llmar login
llmar status`

/** Claude Code runs apiKeyHelper through cmd on Windows: cmd expands %USERPROFILE%, and the quotes keep a profile path with spaces in one piece. */
export const WINDOWS_TOKEN_HELPER = '"%USERPROFILE%\\bin\\llmar-token.cmd"'

export const claudeCode = (v: SnippetValues, platform: Platform = 'unix') => JSON.stringify({
  apiKeyHelper: platform === 'windows' ? WINDOWS_TOKEN_HELPER : '~/bin/llmar-token',
  env: {
    ANTHROPIC_BASE_URL: v.inferenceUrl,
    CLAUDE_CODE_USE_BEDROCK: '0',   // the router, not Bedrock directly (an existing Bedrock setup would win over ANTHROPIC_BASE_URL)
    ANTHROPIC_MODEL: 'auto',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'auto:frontier',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'auto:standard',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'auto:fast',
    // Claude Code does not know 'auto' and would assume a 200K window and compact there; the pool's Claude models have 1M.
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: CLAUDE_CONTEXT_TOKENS,
    CLAUDE_CODE_API_KEY_HELPER_TTL_MS: '240000',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  },
}, null, 2)

/** Desktop seconds between checks of the helper's output. Above 120 it checks before each turn; llmar refreshes 300 s before expiry. */
export const DESKTOP_HELPER_TTL_S = 240

/**
 * Router aliases for Claude Desktop. Its model list refuses ids that do not look like Claude (`auto:frontier` gets
 * "Doesn't look like an Anthropic model", a real setup 2026-11-22), so a deployment needs these names in its policy's
 * aliases. behavesAs and anthropicFamilyTier follow the Claude Code tier mapping (opus frontier, sonnet standard, haiku fast).
 */
export const DESKTOP_ALIASES: ReadonlyArray<{ name: string; target: 'default' | 'frontier' | 'standard' | 'fast'; behavesAs: string; familyTier?: 'opus' | 'sonnet' | 'haiku' }> = [
  { name: 'claude-auto', target: 'default', behavesAs: 'claude-sonnet-5-5' },
  { name: 'claude-opus-auto', target: 'frontier', behavesAs: 'claude-opus-5-5', familyTier: 'opus' },
  { name: 'claude-sonnet-auto', target: 'standard', behavesAs: 'claude-sonnet-5-5', familyTier: 'sonnet' },
  { name: 'claude-haiku-auto', target: 'fast', behavesAs: 'claude-haiku-5-5', familyTier: 'haiku' },
]

/** The Desktop aliases this deployment's policy lacks, or maps to another tier. */
export const missingDesktopAliases = (aliases: Record<string, string>): string[] =>
  DESKTOP_ALIASES.filter((a) => aliases[a.name] !== a.target).map((a) => `${a.name} → ${a.target}`)

/**
 * Claude Desktop on 3P, gateway provider: a JSON config for Import configuration… (top-level keys, as Export writes).
 * The helper runs `llmar credential`: the token goes out as the bearer (the gateway's JWT check) and its x-api-key
 * header carries it again for the router. The gateway's /v1/models list is empty, so the models are listed.
 * Desktop expands neither ~ nor %USERPROFILE% in the helper path: <home> is the full home folder.
 */
export const claudeDesktop = (v: SnippetValues, platform: Platform = 'unix') => JSON.stringify({
  inferenceProvider: 'gateway',
  inferenceGatewayBaseUrl: v.inferenceUrl,
  inferenceGatewayAuthScheme: 'bearer',
  inferenceCredentialHelper: platform === 'windows' ? '<home>\\bin\\llmar.cmd' : '<home>/bin/llmar',
  inferenceCredentialHelperArgs: ['credential'],
  inferenceCredentialHelperTtlSec: DESKTOP_HELPER_TTL_S,
  inferenceModels: DESKTOP_ALIASES.map(({ name, behavesAs, familyTier }) => ({ name, behavesAs, ...(familyTier ? { anthropicFamilyTier: familyTier } : {}) })),
}, null, 2)

/**
 * Paths in the Codex config. Windows: TOML literal strings (single quotes) keep the backslashes; Codex expands
 * neither %USERPROFILE% nor ~ in the auth command, so CODEX_AUTH_PATH_FIX_WINDOWS replaces it after saving. The notes
 * sit on the lines themselves because the step after the block is easy to miss (a Windows setup, 2026-11-22, kept
 * %USERPROFILE% and Codex found neither file). They name no variable, so the fix commands leave them as they are.
 */
const CODEX_PATHS: Record<Platform, { catalog: string; catalogNote: string; command: string; commandNote: string; credentialsHint: string }> = {
  unix: {
    catalog: '"~/.codex/llmar-models.json"',
    catalogNote: '# created by the command above',
    command: '"~/bin/llmar-token"',
    commandNote: '      # must be a full path: the next command writes it',
    credentialsHint: '# credentials_store = "file"          # headless Linux without a keyring: keep this sign-in in $CODEX_HOME/secrets/\n',
  },
  // No credentials_store hint: that line is for headless Linux.
  windows: {
    catalog: "'%USERPROFILE%\\.codex\\llmar-models.json'",
    catalogNote: '# created by the command above; must be a full path (next command)',
    command: "'%USERPROFILE%\\bin\\llmar-token.cmd'",
    commandNote: ' # must be a full path: the next command writes your profile folder here',
    credentialsHint: '',
  },
}

export const codex = (v: SnippetValues, platform: Platform = 'unix') => `model = "auto"
model_provider = "llmar"
model_catalog_json = ${CODEX_PATHS[platform].catalog} ${CODEX_PATHS[platform].catalogNote}
model_context_window = 1000000         # needs the catalog: without it Codex caps "auto" at 272K
model_auto_compact_token_limit = 700000
web_search = "disabled"                # required: Bedrock rejects Codex's built-in web search tool mid-stream

[model_providers.llmar]
name = "llmar router"
base_url = "${v.inferenceUrl}/v1"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false

[model_providers.llmar.auth]           # Authorization: Bearer, refreshed by llmar
command = ${CODEX_PATHS[platform].command}${CODEX_PATHS[platform].commandNote}
timeout_ms = 15000
refresh_interval_ms = 240000

[model_providers.llmar.gateway_oauth]  # Codex's own sign-in; its token goes in x-api-key
authorization_url = "${v.authorizeEndpoint}"
token_url = "${v.tokenEndpoint}"
client_id = "${v.clientId}"
scopes = ["openid", "${v.scope}"]
redirect_port = ${v.codexOauthPort}
delivery = { kind = "header", name = "x-api-key" }
${CODEX_PATHS[platform].credentialsHint}
${codexMemories}
[features]
enable_request_compression = false`

/** Codex names its own model for memory extraction and consolidation (gpt-6-luna), which the router refuses (pin-not-allowed). */
export const codexMemories = `[memories]                             # background memory passes name their own model: keep them on the router
extract_model = "auto:fast"
consolidation_model = "auto:fast"
`
export const claudeContextLine = `"CLAUDE_CODE_MAX_CONTEXT_TOKENS": "${CLAUDE_CONTEXT_TOKENS}"`
export const credentialsStoreLine = 'credentials_store = "file"'
export const configParentFix = 'chmod g-w ~/.config'
export const claudeEnvCheck = "env | grep -E 'CLAUDE_CODE_USE_BEDROCK|ANTHROPIC_API_KEY|ANTHROPIC_BASE_URL'"
export const unsetApiKey = 'unset ANTHROPIC_API_KEY'
/** Checks the llmar sign-in without printing the token (exit 2 and a message on stderr when llmar login is needed). */
export const tokenCheck = 'llmar-token > /dev/null && echo "llmar: signed in"'
export const claudeEnvCheckWindows = "Get-ChildItem Env: | Where-Object Name -match 'CLAUDE_CODE_USE_BEDROCK|ANTHROPIC_API_KEY|ANTHROPIC_BASE_URL'"
export const unsetApiKeyWindows = `Remove-Item Env:ANTHROPIC_API_KEY                                          # this window
[Environment]::SetEnvironmentVariable('ANTHROPIC_API_KEY', $null, 'User')   # if it is one of your user variables`
export const tokenCheckWindows = "llmar-token > $null; if ($LASTEXITCODE -eq 0) { 'llmar: signed in' }"
export const sshForward = (cliPort: number | undefined, codexPort: number | undefined) =>
  `ssh -L ${cliPort ?? 52817}:127.0.0.1:${cliPort ?? 52817} -L ${codexPort ?? 52820}:127.0.0.1:${codexPort ?? 52820} <host>`

/** Codex names its own sessions (turn metadata session_id, read by the router; task 11-23): no session id to make up. */
export const codexRun = (_platform: Platform = 'unix') => 'codex'

/**
 * Codex does not know 'auto' and caps an unknown model's window at 272K, whatever model_context_window says. The
 * catalog gives 'auto' a copy of GPT-6.1 Sol's metadata with Bedrock's 1M window (the smallest in the default
 * Responses pool). Codex versions ship different catalogs (a Windows install had no gpt-6.1-sol, 2026-11-22): the
 * command falls back to another Sol, then to the catalog's first model by priority, and prints the one it copied.
 * model_catalog_json replaces Codex's catalog, so the file keeps every bundled model too; --bundled reads the catalog
 * shipped with the binary, so the command can be run again after an upgrade.
 */
export const codexCatalog = `codex debug models --bundled | python3 -c 'import copy, json, sys
d = json.load(sys.stdin)
ms = d["models"]
pick = [m for s in ("gpt-6.1-sol", "gpt-6.2-sol", "gpt-6-sol") for m in ms if m["slug"] == s]
a = copy.deepcopy((pick or sorted(ms, key=lambda m: m.get("priority") or 99))[0])
print("auto copies", a["slug"], file=sys.stderr)
a.update(slug="auto", display_name="auto (llmar)", description="Routed by llmar", priority=0,
         upgrade=None, availability_nux=None, context_window=1000000, max_context_window=1000000)
d["models"].insert(0, a)
json.dump(d, sys.stdout)' > ~/.codex/llmar-models.json`

/**
 * The same catalog on Windows. Python runs Codex and writes the file itself: a PowerShell pipe or `>` would re-encode
 * the JSON (UTF-16 in Windows PowerShell 5.1). The code has no double quotes, which PowerShell drops from arguments.
 */
export const codexCatalogWindows = `python -c @'
import copy, json, subprocess
from pathlib import Path
d = json.loads(subprocess.run('codex debug models --bundled', shell=True, capture_output=True, check=True).stdout)
ms = d['models']
pick = [m for s in ('gpt-6.1-sol', 'gpt-6.2-sol', 'gpt-6-sol') for m in ms if m['slug'] == s]
a = copy.deepcopy((pick or sorted(ms, key=lambda m: m.get('priority') or 99))[0])
print('auto copies', a['slug'])
a.update(slug='auto', display_name='auto (llmar)', description='Routed by llmar', priority=0,
         upgrade=None, availability_nux=None, context_window=1000000, max_context_window=1000000)
d['models'].insert(0, a)
out = Path.home() / '.codex' / 'llmar-models.json'
out.parent.mkdir(exist_ok=True)
out.write_text(json.dumps(d), encoding='utf-8')
'@`

export const codexShort = (v: SnippetValues, platform: Platform = 'unix') => `[model_providers.llmar]
name = "llmar router"
base_url = "${v.inferenceUrl}/v1"
wire_api = "responses"
env_key = "LLMAR_TOKEN"                # sent as Authorization: Bearer
env_http_headers = { "x-api-key" = "LLMAR_TOKEN" }
requires_openai_auth = false
supports_websockets = false

# run: ${platform === 'windows' ? '$env:LLMAR_TOKEN = llmar-token; codex' : 'LLMAR_TOKEN=$(llmar-token) codex'}`

// Windows: subprocess does not try .cmd for a bare name, so the helper is named with its extension.
const sdkCommon = (platform: Platform) => `import subprocess, uuid
import anthropic, openai
import httpx2 as httpx   # anthropic>=2 / openai>=3 ship httpx2; older releases use httpx

def router_token() -> str:   # llmar answers from its cache; it refreshes 5 min before expiry
    return subprocess.run(['${platform === 'windows' ? 'llmar-token.cmd' : 'llmar-token'}'], capture_output=True, text=True, check=True).stdout.strip()

class RouterAuth(httpx.Auth):   # both headers on every request
    def auth_flow(self, request):
        t = router_token()
        request.headers['authorization'] = f'Bearer {t}'
        request.headers['x-api-key'] = t
        yield request

session = {'x-router-session': str(uuid.uuid4())}   # one id per agent session`

export const anthropicSdk = (v: SnippetValues, platform: Platform = 'unix') => `${sdkCommon(platform)}
claude = anthropic.Anthropic(base_url='${v.inferenceUrl}', auth_token='unused', default_headers=session,
                             http_client=httpx.Client(auth=RouterAuth()))
msg = claude.messages.create(model='auto', max_tokens=512, messages=[{'role': 'user', 'content': 'Hello'}])`

export const openaiSdk = (v: SnippetValues, platform: Platform = 'unix') => `${sdkCommon(platform)}
oai = openai.OpenAI(base_url='${v.inferenceUrl}/v1', api_key='unused', default_headers=session,
                    http_client=httpx.Client(auth=RouterAuth()))
resp = oai.responses.create(model='auto', input='Hello', store=False)`

export const curl = (v: SnippetValues) => `TOKEN=$(llmar-token)
curl -sS "${v.inferenceUrl}/v1/messages" -H "Authorization: Bearer $TOKEN" -H "x-api-key: $TOKEN" \\
  -H 'content-type: application/json' -H 'anthropic-version: 2023-06-01' -H "x-router-session: $(uuidgen)" \\
  -d '{"model": "auto", "max_tokens": 256, "messages": [{"role": "user", "content": "Say ok."}]}' -D -`

/** PowerShell: the body goes in on stdin (-d '@-'), because PowerShell drops the double quotes of a JSON argument. */
export const curlWindows = (v: SnippetValues) => `$token = llmar-token
'{"model": "auto", "max_tokens": 256, "messages": [{"role": "user", "content": "Say ok."}]}' |
  curl.exe -sS "${v.inferenceUrl}/v1/messages" -H "Authorization: Bearer $token" -H "x-api-key: $token" \`
  -H "content-type: application/json" -H "anthropic-version: 2023-06-01" -H "x-router-session: $([guid]::NewGuid())" \`
  -d '@-' -D -`
