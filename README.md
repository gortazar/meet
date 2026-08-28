# meet — one click from the top bar into an OpenVidu Meet room

A GNOME Shell panel button whose menu lists your meeting rooms. Click one and it opens in
your default browser. Nothing to configure to get started: **Meet next** and **Meet** are
there from the first launch, and you can add, edit or remove entries in the preferences.

_Installation instructions land with the first release._

## Development

```sh
nix develop        # gjs, eslint, glib, and everything the suite needs
gjs -m tests/run.js   # the headless suite
nix flake check    # lint + suite + schema + pack
nix build          # the packed .shell-extension.zip
```

## Licence

GPL-2.0-or-later, the licence GNOME Shell extensions are expected to carry. See
[`src/LICENSE`](src/LICENSE).

OpenVidu and OpenVidu Meet are trademarks of their owners. This extension is an independent
launcher and ships no OpenVidu artwork: its panel icon is an original symbolic drawing.
