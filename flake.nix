{
  description = "OpenVidu Meet for GNOME Shell — one click from the top bar into a room";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };

        uuid = "meet@meet-gs.patxi";

        # The file set an upload zip must contain: sources at the zip root, schemas
        # compiled alongside their XML.
        #
        # `gnome-extensions pack` would assemble this, but it ships with gnome-shell —
        # about a gigabyte of closure to download for one CLI invocation, in a check that
        # otherwise needs no compositor at all. This does the same assembly and asserts the
        # same things the tool would refuse on.
        packExtension = pkgs.writeShellApplication {
          name = "meet-pack";
          # glib-compile-schemas lives in glib's `dev` output, and runtimeInputs only puts
          # the default output on PATH.
          runtimeInputs = [ pkgs.glib.dev pkgs.zip pkgs.jq ];
          text = ''
            src="$1"
            outDir="$2"
            stage="$(mktemp -d)"
            trap 'rm -rf "$stage"' EXIT

            # extensions.gnome.org rejects a metadata.json missing any of these, and so
            # does gnome-extensions pack.
            for field in uuid name description shell-version url; do
              jq -e --arg f "$field" \
                'has($f) and (.[$f] | if type == "array" then length > 0 else . != "" end)' \
                "$src/metadata.json" >/dev/null \
                || { echo "metadata.json: missing or empty \"$field\"" >&2; exit 1; }
            done
            jq -e --arg u '${uuid}' '.uuid == $u' "$src/metadata.json" >/dev/null \
              || { echo "metadata.json: uuid is not ${uuid}" >&2; exit 1; }

            cp "$src/metadata.json" "$src/extension.js" "$src/LICENSE" "$stage/"
            if [ -f "$src/prefs.js" ]; then
              cp "$src/prefs.js" "$stage/"
            fi
            if [ -d "$src/lib" ]; then
              mkdir -p "$stage/lib"
              cp "$src"/lib/*.js "$stage/lib/"
            fi
            if [ -d "$src/icons" ]; then
              cp -r "$src/icons" "$stage/"
            fi
            if [ -d "$src/schemas" ]; then
              mkdir -p "$stage/schemas"
              cp "$src"/schemas/*.gschema.xml "$stage/schemas/"
            fi
            # Sources copied out of the nix store arrive read-only, directories included,
            # which leaves the staging area impossible to clean up on the way out.
            chmod -R u+w "$stage"

            # The shell reads the compiled file, so a schema that will not compile has to
            # fail here rather than at install time.
            if [ -d "$stage/schemas" ]; then
              glib-compile-schemas --strict "$stage/schemas"
            fi

            mkdir -p "$outDir"
            ( cd "$stage" && zip -qr "$outDir/${uuid}.shell-extension.zip" . )
            echo "packed $outDir/${uuid}.shell-extension.zip"
          '';
        };

        # The suite loads the shipped icon through GdkPixbuf — the check that catches an
        # SVG the shell cannot draw — and that needs both GdkPixbuf's typelib and the SVG
        # loader librsvg provides. Neither is in gjs's own closure, and the loader is only
        # found through a cache that has to be generated here.
        pixbufEnv = ''
          export GI_TYPELIB_PATH="${pkgs.gdk-pixbuf}/lib/girepository-1.0''${GI_TYPELIB_PATH:+:$GI_TYPELIB_PATH}"
          export GDK_PIXBUF_MODULEDIR="${pkgs.librsvg}/lib/gdk-pixbuf-2.0/2.10.0/loaders"
          gdk-pixbuf-query-loaders > "$PWD/loaders.cache"
          export GDK_PIXBUF_MODULE_FILE="$PWD/loaders.cache"
        '';
      in {
        # `nix develop` — everything needed to work on this extension.
        devShells.default = pkgs.mkShell {
          packages = [
            pkgs.gjs # runs the headless test suite
            pkgs.gdk-pixbuf # the icon-loading test
            pkgs.librsvg # ... and the SVG loader it needs
            pkgs.glib.dev # glib-compile-schemas
            pkgs.eslint
            pkgs.zip
            pkgs.unzip
            pkgs.jq
            pkgs.git
            packExtension
          ];

          shellHook = ''
            echo "meet dev shell"
            echo "  gjs -m tests/run.js   headless suite"
            echo "  eslint .              lint (same version nix flake check runs)"
            echo "  nix flake check       lint + suite + pack, against git HEAD"
            echo "  nix build             packed .shell-extension.zip"
          '';
        };

        checks = {
          # Every module under lib/ imports only GLib/Gio, so the whole suite runs under
          # plain gjs: no display, no compositor, no dbus.
          unit-tests = pkgs.runCommand "meet-unit-tests"
            {
              src = self;
              nativeBuildInputs = [ pkgs.gjs pkgs.gdk-pixbuf pkgs.librsvg pkgs.coreutils ];
            } ''
            cp -r "$src" ./source
            chmod -R u+w ./source
            cd ./source
            ${pixbufEnv}
            gjs -m tests/run.js | tee "$out"
          '';

          lint = pkgs.runCommand "meet-lint"
            {
              src = self;
              nativeBuildInputs = [ pkgs.eslint ];
            } ''
            cp -r "$src" ./source
            chmod -R u+w ./source
            cd ./source
            eslint . | tee "$out"
            echo "lint OK" >> "$out"
          '';

          # Packaging mistakes are publish blockers, so treat one as a test failure: an
          # incomplete zip is how a working extension still ends up broken for everyone who
          # installs it.
          pack = pkgs.runCommand "meet-pack"
            {
              src = self;
              nativeBuildInputs = [ packExtension pkgs.unzip ];
            } ''
            meet-pack "$src/src" "$PWD/out"
            zip="$PWD/out/${uuid}.shell-extension.zip"

            # Listed once into a variable, and searched without a pipeline. `unzip -l |
            # grep -q` looks equivalent and is not: grep exits at the first match, unzip
            # dies of SIGPIPE, and with pipefail the whole check fails at random depending
            # on which of them the scheduler ran first.
            listing="$(unzip -l "$zip")"
            echo "$listing"
            # lib/ is the easy thing to leave out, and the extension does not load without
            # it. Every module the shell-side code imports is named here.
            for entry in metadata.json extension.js LICENSE \
                lib/destinations.js lib/launcher.js lib/icon.js \
                icons/openvidu-meet-symbolic.svg; do
              grep -q " $entry\$" <<< "$listing" \
                || { echo "packed zip is missing $entry" >&2; exit 1; }
            done
            echo "pack OK" > "$out"
          '';
        };

        # `nix build` — the uploadable artifact.
        packages.default = pkgs.runCommand "meet-shell-extension"
          {
            src = self;
            nativeBuildInputs = [ packExtension ];
          } ''
          meet-pack "$src/src" "$out"
        '';

        # `nix run .#tests` — the same suite against the working tree, which is what you
        # want while editing. Impure on purpose: it reads the checkout, not a store path.
        apps.tests = {
          type = "app";
          meta.description = "Run the headless suite against the working tree";
          program = "${pkgs.writeShellApplication {
            name = "meet-tests";
            runtimeInputs = [ pkgs.gjs pkgs.gdk-pixbuf pkgs.librsvg ];
            text = ''
              cd "''${1:-.}"
              ${pixbufEnv}
              exec gjs -m tests/run.js
            '';
          }}/bin/meet-tests";
        };
      });
}
