import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { highlightPlaceholders, Kpi, placeholdersIn } from './blocks.tsx'
import * as S from '../pages/getstarted-snippets.ts'

describe('snippet placeholders', () => {
  it('finds <name> tokens once each, and ignores code that only uses < or >', () => {
    expect(placeholdersIn('a <you> b <you> c <Codex callback port>')).toEqual(['you', 'Codex callback port'])
    expect(placeholdersIn("def f() -> str:\n    x = a > b and c < d\n    # anthropic>=2")).toEqual([])
    expect(placeholdersIn('TOKEN=$(llmar-token) <<EOF')).toEqual([])
  })

  it('highlights each placeholder and keeps the rest of the text byte for byte', () => {
    const code = 'command = "/home/<you>/bin/llmar-token"\nredirect_port = <Codex callback port>'
    const { container } = render(<pre>{highlightPlaceholders(code)}</pre>)
    expect([...container.querySelectorAll('mark[data-testid="placeholder"]')].map((m) => m.textContent)).toEqual(['<you>', '<Codex callback port>'])
    expect(container.textContent).toBe(code)
  })

  it('the Codex snippet needs no placeholders when the deployment provides every value', () => {
    const setup = { inferenceUrl: 'https://gw.example/inference', authorizeEndpoint: 'https://d.example/oauth2/authorize',
      tokenEndpoint: 'https://d.example/oauth2/token', clientId: 'cli123', scope: 'llmar/invoke', codexOauthPort: 52820 }
    const v = S.snippetValues(setup as never, 'https://raw.example/llmar')
    expect(placeholdersIn(S.codex(v))).toEqual([])
    expect(S.codex(v)).toContain('redirect_port = 52820')
    const missing = S.snippetValues({ ...setup, codexOauthPort: undefined } as never, undefined)
    expect(placeholdersIn(S.codex(missing))).toContain('Codex callback port')
    expect(placeholdersIn(S.install(missing))).toEqual([S.CLI_RAW_URL_PLACEHOLDER])
    for (const n of placeholdersIn(S.codex(missing))) expect(S.DEPLOYMENT_PLACEHOLDERS.has(n)).toBe(true)
    // Headless Linux hint ships in the snippet, commented out (the OS keyring is the better store where it exists).
    expect(S.codex(v)).toMatch(/^# credentials_store = "file" .*keyring/m)
    expect(S.sshForward(52817, 52820)).toBe('ssh -L 52817:127.0.0.1:52817 -L 52820:127.0.0.1:52820 <host>')
    expect(placeholdersIn(S.sshForward(52817, 52820))).toEqual(['host'])
    // Claude Code must not fall back to its own Bedrock setup (CLAUDE_CODE_USE_BEDROCK wins over ANTHROPIC_BASE_URL).
    expect(JSON.parse(S.claudeCode(v)).env).toMatchObject({ CLAUDE_CODE_USE_BEDROCK: '0', ANTHROPIC_BASE_URL: setup.inferenceUrl })
    // Claude Code assumes 200K for 'auto' and compacts there unless told the window.
    expect(JSON.parse(S.claudeCode(v)).env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe('1000000')
    expect(JSON.parse(`{${S.claudeContextLine}}`)).toEqual({ CLAUDE_CODE_MAX_CONTEXT_TOKENS: '1000000' })
    // Codex memory passes name gpt-6-luna unless told otherwise; the router refuses it (pin-not-allowed).
    expect(S.codex(v)).toMatch(/\n\[memories\][^\n]*\nextract_model = "auto:fast"\nconsolidation_model = "auto:fast"\n\n\[features\]/)
    // Codex caps the unknown 'auto' at 272K unless a model catalog gives it a window; the command writes the file
    // config.toml points at, from the bundled catalog (so it can be rerun), with no placeholder to fill in.
    expect(S.codex(v)).toContain('model_catalog_json = "~/.codex/llmar-models.json"')
    expect(S.codex(v)).toContain('command = "~/bin/llmar-token"')
    expect(S.codexCatalog).toMatch(/^codex debug models --bundled \|/)
    expect(S.codexCatalog).toMatch(/context_window=1000000, max_context_window=1000000\)/)
    expect(S.codexCatalog).toMatch(/> ~\/\.codex\/llmar-models\.json$/)
    // Codex versions ship different catalogs (a Windows install had no gpt-6.1-sol): another Sol, then the catalog's
    // first model by priority, never a bare next() that ends in StopIteration. Both commands print the model copied.
    for (const c of [S.codexCatalog, S.codexCatalogWindows]) {
      expect(c).not.toMatch(/next\(/)
      expect(c).toMatch(/for s in \(.gpt-6\.1-sol., .gpt-6\.2-sol., .gpt-6-sol.\) for m in ms if m\[.slug.\] == s\]/)
      expect(c).toMatch(/\(pick or sorted\(ms, key=lambda m: m\.get\(.priority.\) or 99\)\)\[0\]/)
      expect(c).toMatch(/print\(.auto copies., a\[.slug.\]/)
    }
    // The Unix command's stdout is the catalog file, so the note goes to stderr; PowerShell drops double quotes.
    expect(S.codexCatalog).toContain('print("auto copies", a["slug"], file=sys.stderr)')
    expect(S.codexCatalogWindows).not.toContain('"')
    expect(placeholdersIn(S.codexCatalog)).toEqual([])
    // The 403 FAQ check never prints the token.
    expect(S.tokenCheck).toMatch(/^llmar-token > \/dev\/null && /)
  })

  it('Windows (PowerShell) snippets use .cmd helpers and Windows paths, with nothing to fill in by hand', () => {
    const setup = { inferenceUrl: 'https://gw.example/inference', authorizeEndpoint: 'https://d.example/oauth2/authorize',
      tokenEndpoint: 'https://d.example/oauth2/token', clientId: 'cli123', scope: 'llmar/invoke', codexOauthPort: 52820,
      configureJson: { clientId: 'cli123', scope: 'llmar/invoke' } }
    const v = S.snippetValues(setup as never, "https://raw.example/it's/llmar")
    expect(S.detectPlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('windows')
    expect(S.detectPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe('unix')
    // Install: curl.exe (curl is an alias in Windows PowerShell), a PowerShell-quoted URL, and one .cmd per command name.
    expect(S.installWindows(v)).toContain(`curl.exe -fsSLo "$bin\\llmar" 'https://raw.example/it''s/llmar'`)
    expect(S.installWindows(v)).toContain(`Set-Content "$bin\\llmar-token.cmd" '@python "%~dp0llmar" token %*'`)
    expect(S.installWindows(v)).toContain(`Set-Content "$bin\\llmar-login.cmd" '@python "%~dp0llmar" login %*'`)
    // Configure: the JSON goes in on stdin, never as an argument (PowerShell drops its double quotes).
    expect(S.configureWindows(v)).toBe(`@'\n{"clientId":"cli123","scope":"llmar/invoke"}\n'@ | llmar configure --from -`)
    // Claude Code runs the helper through cmd: %USERPROFILE% expands there, the inner quotes survive spaces.
    expect(JSON.parse(S.claudeCode(v, 'windows')).apiKeyHelper).toBe('"%USERPROFILE%\\bin\\llmar-token.cmd"')
    expect(JSON.parse(S.claudeCode(v, 'windows')).env).toEqual(JSON.parse(S.claudeCode(v)).env)
    // Codex: TOML literal strings keep the backslashes; the fix command replaces %USERPROFILE% in both paths.
    expect(S.codex(v, 'windows')).toContain(`model_catalog_json = '%USERPROFILE%\\.codex\\llmar-models.json'`)
    expect(S.codex(v, 'windows')).toContain(`command = '%USERPROFILE%\\bin\\llmar-token.cmd'`)
    expect(S.codex(v, 'windows')).not.toContain('credentials_store')
    expect(S.codex(v, 'windows')).toMatch(/\ndelivery = [^\n]*\n\n\[memories\]/)
    expect(S.codex(v, 'windows').match(/%USERPROFILE%/g)).toHaveLength(2)
    expect(S.CODEX_AUTH_PATH_FIX_WINDOWS).toContain(`.replace('%USERPROFILE%', str(Path.home()))`)
    // Python snippets passed through PowerShell carry no double quotes, and the catalog matches the POSIX one.
    for (const code of [S.codexCatalogWindows, S.CODEX_AUTH_PATH_FIX_WINDOWS]) {
      expect(code).toMatch(/^python -c @'\n[^]*\n'@$/)
      expect(code).not.toContain('"')
    }
    expect(S.codexCatalogWindows).toContain("context_window=1000000, max_context_window=1000000)")
    // Codex names its own sessions (task 11-23): no session id variable, no x-router-session header.
    expect(S.codexRun('windows')).toBe('codex')
    expect(S.codexRun()).toBe('codex')
    expect(S.codexShort(v, 'windows')).toContain('# run: $env:LLMAR_TOKEN = llmar-token; codex')
    expect(S.codexShort(v)).toContain('# run: LLMAR_TOKEN=$(llmar-token) codex')
    for (const code of [S.codex(v), S.codex(v, 'windows'), S.codexShort(v), S.codexShort(v, 'windows')]) {
      expect(code).not.toContain('LLMAR_SESSION')
      expect(code).not.toContain('x-router-session')
    }
    expect(S.anthropicSdk(v, 'windows')).toContain("subprocess.run(['llmar-token.cmd']")
    expect(S.openaiSdk(v)).toContain("subprocess.run(['llmar-token']")
    expect(S.curlWindows(v)).toMatch(/-d '@-' -D -$/)
    expect(S.tokenCheckWindows).toMatch(/^llmar-token > \$null; /)
    for (const code of [S.installWindows(v), S.configureWindows(v), S.claudeCode(v, 'windows'), S.codexCatalogWindows, S.codex(v, 'windows'),
      S.CODEX_AUTH_PATH_FIX_WINDOWS, S.codexRun('windows'), S.codexShort(v, 'windows'), S.curlWindows(v), S.unsetApiKeyWindows]) expect(placeholdersIn(code)).toEqual([])
    // The default platform leaves every POSIX snippet as it was.
    expect(S.codex(v, 'unix')).toBe(S.codex(v))
    expect(S.claudeCode(v, 'unix')).toBe(S.claudeCode(v))
  })
})

describe('Kpi', () => {
  it('text values (caller, models) use the smaller text style; numbers keep the large one', () => {
    const text = render(<Kpi text label="Caller" value="someone@example.com" />)
    expect(text.getByTestId('kpi-text').textContent).toBe('someone@example.com')
    const num = render(<Kpi label="Requests" value="634" />)
    expect(num.container.querySelector('[data-testid="kpi-text"]')).toBeNull()
    expect(num.container.textContent).toContain('634')
  })
})
