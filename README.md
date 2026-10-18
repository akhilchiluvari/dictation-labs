# Dictation Lab

Dictation Lab is the first project in Trinity Protocol: an original, Windows-first desktop dictation tool inspired by the workflow of modern voice-to-text editors.

> **Status:** first vertical slice. The interface, settings model, local retry queue, audio capture path, provider abstraction, and paste bridge are implemented. Local Whisper.cpp and OpenAI/Groq transcription are wired in the Rust desktop shell; they need a configured model/binary or API key to run.

## What works

- Windows desktop shell through Tauri 2 with a browser-preview fallback.
- Global `Alt+Space` shortcut by default, configurable to supported `Ctrl`, `Alt`, `Shift`, `Win`, letter, `Space`, or `F1`–`F12` combinations.
- Hold-to-dictate and toggle-session modes.
- A hands-free start/stop control and an automatic five-minute safety limit.
- Escape cancellation while recording and cancellation of a running transcription request.
- Microphone capture to WAV through `cpal`.
- Local Whisper.cpp, OpenAI Whisper, and Groq Whisper provider paths.
- Optional LLM cleanup with a strict meaning-preserving prompt.
- Local deterministic cleanup fallback when no LLM key is configured.
- Clipboard insertion at the focused cursor through `Ctrl+V`.
- Optional previous-clipboard restoration after paste.
- Persistent offline queue in the app data directory. Failed jobs stay on disk and retry when requested or when the app sees the connection return.
- Raw audio retention toggle. Audio is only removed after a successful transcript when retention is disabled.
- Personal vocabulary, writing style, profile notes, provider selection, language selection, and local cloud-minute guardrails.
- No account, analytics, or telemetry code.

The “voice profile” is deliberately a **writing and vocabulary profile**, not biometric speaker identification. Dictation Lab does not create a voiceprint.

## First run on Windows

### Prerequisites

1. Node.js 22.14.0 or newer.
2. Rust 1.90.0 or newer with the Windows MSVC toolchain. The repository pins Rust 1.90.0 for reproducible builds.
3. Tauri’s Windows prerequisites, including Microsoft C++ Build Tools and WebView2. Follow the official Tauri 2 Windows setup guide for the system packages.
4. A Whisper.cpp installation and model for offline transcription, or an OpenAI/Groq key for cloud transcription.

From this folder:

```powershell
npm test
npm run check
npm run build
```

The static browser preview can be opened with:

```powershell
npm run dev
```

Then open <http://127.0.0.1:1420>. Browser preview can request the microphone, but it cannot provide a true system-wide shortcut or paste into arbitrary Windows applications. Preview audio is held in memory only and is discarded when recording stops. Use the Tauri shell for the real workflow and durable offline retry.

### Run the desktop shell

Install the Tauri CLI into your user Cargo bin if it is not already available:

```powershell
cargo install tauri-cli --version "^2"
cargo tauri dev
```

For a reproducible project-local CLI instead, install it into a local tools directory and call that executable from your shell; do not commit the downloaded binary.

## Configure transcription

Copy the example environment file during local development:

```powershell
Copy-Item .env.example .env
```

### Offline local mode

Install `whisper.cpp`, download an English model such as `ggml-medium.en.bin`, and set:

```dotenv
WHISPER_BINARY=C:\\path\\to\\whisper-cli.exe
WHISPER_MODEL=C:\\path\\to\\ggml-medium.en.bin
```

In Settings, choose **Local Whisper.cpp**. If the binary is on `PATH`, `WHISPER_BINARY=whisper-cli` is enough.

### OpenAI or Groq mode

Set one of these keys and choose the matching provider in Settings:

```dotenv
OPENAI_API_KEY=replace-me
GROQ_API_KEY=replace-me
```

The keys are read by Rust and are not displayed back to the web UI. Do not commit `.env`.

### Optional cleanup model (not required)

The default local path is zero-cost. Local Whisper.cpp is followed by a deterministic cleanup pass in Rust. Cleanup uses an OpenAI-compatible Chat Completions endpoint only when you explicitly provide a separate `LLM_API_KEY`; it never reuses a transcription key automatically:

```dotenv
LLM_API_KEY=replace-me
LLM_BASE_URL=https://api.openai.com/v1/chat/completions
LLM_MODEL=gpt-4o-mini
```

If cleanup cannot reach the service, Dictation Lab keeps the transcription and applies a small deterministic cleanup instead of dropping the words.

You can therefore leave every key blank and use Dictation Lab without an account or API bill. Cloud provider choices are optional adapters for a later experiment, not part of the required setup.

## Permissions and Windows behavior

- **Microphone:** Windows Settings → Privacy & security → Microphone. Allow microphone access for desktop apps.
- **Global shortcut:** the app registers its shortcut at startup. If another application owns the shortcut, choose another one in Settings.
- **Paste:** Dictation Lab uses the clipboard and simulated `Ctrl+V`. A normal focused application should accept it. Windows prevents lower-privilege apps from automating elevated applications; run Dictation Lab at the same privilege level as the target application rather than disabling Windows security.
- **Security software:** an antivirus or enterprise policy may block global keyboard hooks or simulated input. Allow the signed/local build if your environment asks.
- **No macOS permissions are needed:** Accessibility and Input Monitoring are macOS concepts and do not apply to this Windows build.

## Offline retry behavior

Each finished recording is stored under the platform app-data directory in `recordings/`, with queue metadata in `jobs.json`. The flow is:

1. Record audio locally.
2. Add the audio path to the queue.
3. Try the configured provider.
4. If the network/provider/model is unavailable, keep the WAV and error message.
5. Retry manually from the queue or automatically after the app sees the connection return.
6. After a transcript succeeds, copy it to the clipboard and paste it at the focused cursor.
7. Delete the WAV after success only when **Keep raw audio after success** is disabled.

The default is intentionally conservative: raw audio is retained after success until you opt out. For maximum privacy, disable retention and use local Whisper.cpp.

## Accuracy strategy

The accuracy target is not “raw Whisper text.” Dictation Lab separates the pipeline so it can be measured and improved:

```text
microphone → WAV capture → transcription provider → meaning-preserving cleanup → paste
```

The cleanup prompt preserves names, numbers, URLs, acronyms, code, corrections, and intent. The vocabulary/profile settings provide the context that a generic transcription model does not have. The next accuracy milestone is a recorded benchmark set covering names, numbers, noisy rooms, fast speech, corrections, technical language, and accents.

## Checks

The single offline frontend check is:

```powershell
npm test
```

Additional local checks:

```powershell
npm run check
npm run build
cargo check --locked --manifest-path src-tauri/Cargo.toml
```

`cargo check` requires the Windows/Tauri toolchain and network access the first time crates are resolved. The frontend tests use only Node’s built-in test runner and need no network.

## Docker / static preview

The Dockerfile validates and serves the browser preview. It is not a replacement for a Windows Tauri build because Tauri must link against the Windows desktop toolchain.

```bash
docker build -t dictation-lab .
docker run --rm -p 1420:1420 dictation-lab
```

Open <http://127.0.0.1:1420>.

## Product naming

`dictation-lab` is temporary until the Trinity Protocol product name is chosen. The app uses original branding and does not ship Wispr Flow assets or trademarks.
