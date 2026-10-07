# Blender (`connectors/blender`)

Blender 3D creation suite connected via the `blender-mcp` stdio server to Blender's local socket.
Reads scene data and viewport captures; executes Python and imports 3D assets into the active scene.

## Read first

- **Start Blender and the server:**
  1. Open Blender (`/Applications/Blender.app` or `blender` in terminal).
  2. In the 3D Viewport, press `N` to open the sidebar.
  3. Select the **MCP for Blender** tab.
  4. Click **Start MCP Server** (listens on `localhost:9876`).
- **First read:** `mcp__blender__get_scene_info()` — proves socket connection and lists all objects, collections, and cameras in the active scene.
- **Visual proof:** `mcp__blender__get_viewport_screenshot()` captures the current 3D viewport state.
- **Addon health:** `mcp__blender__get_addon_status()` reports version and protocol compatibility.
- **Writes:** `execute_blender_code` runs arbitrary Python with full `bpy` access. There is no automated rollback for scripted mutations; save the scene or push an undo step before executing changes.
- **Doctor check:** `toolbelt doctor blender` — verifies `uv`, `Blender.app`, the installed addon, registration, and live socket connection.

## No business logic lives here

The connector contributes registration, doctor checks, and the verb contract. Execution safety is
in Blender's Python runtime and local scene state:
- No cloud credentials are required for local modeling, shading, lighting, and rendering.
- Loopback only: `blender-mcp` talks to `localhost:9876` inside the operator's desktop session.

## Writes: the contract that stands in for a gate

| Verb | What it modifies | Rule |
|---|---|---|
| `execute_blender_code` | active scene geometry, materials, objects, animation | Show or explain the script before running; verify the active scene is saved or uncompromised; re-read with `get_scene_info()` or `get_viewport_screenshot()` |
| `set_texture` | material and texture slots on selected objects | Specify the target object name and texture parameters; re-read scene state |
| `download_polyhaven_asset` | active scene (imports CC0 texture/HDR/model) | Preview category and asset name with `search_polyhaven_assets` first |
| `download_sketchfab_model` | active scene (imports Sketchfab model) | Requires Sketchfab API key if downloading authenticated models |
| `download_polypizza_model` | active scene (imports low-poly model) | Preview model name with `search_polypizza_models` first |
| `generate_hyper3d_*`, `generate_hunyuan3d_*` | external AI generation services | Paid API calls requiring user-supplied API keys; confirm before triggering |
| `disable_telemetry` | `blender-mcp` telemetry configuration | One-time toggle |

## Registration

`bin/toolbelt register blender` prints the `~/.claude.json` configuration snippet; `--write`
merges it after creating a backup (interactive terminal required).

For Antigravity, add to `~/.gemini/config/mcp_config.json`:
```json
{
  "mcpServers": {
    "blender": {
      "command": "uvx",
      "args": ["blender-mcp"],
      "env": {
        "BLENDER_HOST": "localhost",
        "BLENDER_PORT": "9876"
      }
    }
  }
}
```
