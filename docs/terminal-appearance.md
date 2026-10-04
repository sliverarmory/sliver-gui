# Terminal appearance and Ghostty themes

Open **Settings → Terminal** to choose a Ghostty theme and preview its colors.
Theme selections apply immediately to open consoles, SSH sessions, and managed
shells. The settings button in each standalone console or SSH toolbar opens the
shared font, cursor, scrolling, and transparency preferences.

## Config location and editing

Sliver GUI stores terminal theme configuration under the Sliver client root:

| File or directory | Purpose |
| --- | --- |
| `~/.sliver-client/gui/ghostty/config` | Ghostty-format appearance configuration |
| `~/.sliver-client/gui/ghostty/themes/` | Custom Ghostty theme files |
| `~/.sliver-client/gui/application-settings.json` | Font, cursor, scrolling, and transparent-window preferences |

`SLIVER_CLIENT_ROOT_DIR` changes the root of all these paths. Settings displays
the actual config and theme directories used by the running app.

Choose **Edit Ghostty config** to open the config in the standalone Monaco editor.
Saving updates open terminals; **Reload themes** refreshes the config and the
theme catalog, including changes to externally installed themes. Configuration
notes identify invalid colors, missing files, and unsupported options by source
file and line where available.

The config uses Ghostty's `key = value` syntax. For example:

```ini
# Use a theme available in the theme selector.
theme = Catppuccin Mocha

# Optional color overrides take precedence over the theme.
cursor-color = #f5e0dc
selection-background = #585b70
selection-foreground = #cdd6f4
background-opacity = 0.85
```

Choose **Application default** to clear the named theme. Explicit color overrides
in the config still apply; remove or empty those assignments to restore the
application colors completely.

Separate light and dark themes are supported:

```ini
theme = light:Catppuccin Latte,dark:Catppuccin Mocha
```

Sliver GUI chooses the pair member using its own resolved app appearance,
including the app's light/dark override. An absolute theme-file path can also be
used as the theme value. These forms follow [Ghostty's theme syntax](https://ghostty.org/docs/features/theme).

## Sharing themes with native Ghostty

The GUI reads standard Ghostty theme files directly. It searches the GUI themes
directory first, then these native locations in order; the first file with a
given name wins:

1. `$XDG_CONFIG_HOME/ghostty/themes`, or `~/.config/ghostty/themes` when the variable
   is not an absolute path.
2. On macOS, `~/Library/Application Support/com.mitchellh.ghostty/themes`, followed
   by the Ghostty application resources in `~/Applications/Ghostty.app` and
   `/Applications/Ghostty.app` (`Contents/Resources/ghostty/themes`).
3. `$GHOSTTY_RESOURCES_DIR/themes`, when the variable is an absolute path.
4. `ghostty/themes` beneath each `$XDG_DATA_DIRS` entry, defaulting to
   `/usr/local/share` and `/usr/share`.
5. On macOS, `/opt/homebrew/share/ghostty/themes`.

Native Ghostty's installed theme collection is discovered locally; the GUI does
not download a catalog. To share custom themes by name, place them in a native
Ghostty theme directory listed above. For a theme stored only in the GUI's themes
directory, use its absolute path when sharing the configuration.

Native Ghostty can import the GUI config using its [`config-file` option](https://ghostty.org/docs/config/reference#config-file):

```ini
config-file = ~/.sliver-client/gui/ghostty/config
```

Use the actual config path shown in Settings when you use a different client
root. Native Ghostty imports apply after the containing config. The GUI does not
read or modify native Ghostty's main config and does not follow `config-file`
directives itself; its appearance comes from the GUI config and selected theme.

## Transparent standalone windows

**Transparent terminal windows** is enabled by default. Console and SSH windows
use native sidebar vibrancy on macOS and acrylic on Windows 11 22H2 or newer
(build 22621+). Linux and older Windows versions retain an opaque window.

Turning the setting off immediately restores an opaque terminal background while
retaining the selected colors. With transparency enabled on a supported platform,
`background-opacity` controls the terminal tint from `0` to `1`; its GUI default
is `0.22`, matching the main sidebar's tint over the native glass material. An
explicit Ghostty opacity also applies to the terminal toolbar. Managed shell
panels remain opaque. The operating system controls the
native blur and may reduce transparency according to its accessibility settings.

The embedded renderer exposes resolved cell RGB values rather than whether a
background color was explicitly set. Cells whose background RGB exactly matches
the theme background inherit its opacity, even when a terminal program explicitly
selected that same color. Other background colors and text remain opaque.

## Embedded runtime compatibility

The pinned `ghostty-web` runtime applies foreground, background, cursor and cursor
text, selection foreground/background, and ANSI palette colors 0–15. Ghostty RGB
and X11 color names are accepted. Config palette entries 16–255 are preserved
but are not applied to the embedded renderer's extended palette.

Dynamic cell colors (`cell-foreground` and `cell-background`), custom shaders,
native font settings, command settings, keybindings, and other native-only
options are preserved in the file and reported as configuration notes. They do
not alter the embedded runtime. Use the GUI's controls for fonts, cursor shape,
blinking, and scrolling. Theme selection updates only the effective `theme`
assignment, preserving comments and unrelated settings.

Color-theme changes recreate the embedded display without reconnecting the
console or SSH transport. The display retains at most 4 MiB or 2,048 output chunks,
whichever limit is reached first, and replays that recent output. Older output
beyond this retained history is not reconstructed after a theme
change. This replay is local and does not send commands or terminal responses to
the connection. Configuration and theme files are limited to 256 KiB each and
must be regular UTF-8 files.
