{
  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixpkgs-unstable";
  };
  outputs = {nixpkgs, ...}: let
    forAllSystems = function:
      nixpkgs.lib.genAttrs nixpkgs.lib.systems.flakeExposed (
        system: function nixpkgs.legacyPackages.${system}
      );
    nodeToolchain = pkgs: rec {
      nodejs = pkgs.nodejs_26;
      corepack = pkgs.corepack;
      pnpm = pkgs.writeShellApplication {
        name = "pnpm";
        text = ''
          exec ${nodejs}/bin/node ${corepack}/dist/pnpm.js "$@"
        '';
      };
      pnpx = pkgs.writeShellApplication {
        name = "pnpx";
        text = ''
          exec ${nodejs}/bin/node ${corepack}/dist/pnpx.js "$@"
        '';
      };
    };
  in {
    formatter = forAllSystems (pkgs: pkgs.alejandra);
    checks = forAllSystems (pkgs: let
      inherit (nodeToolchain pkgs) corepack nodejs pnpm;
      inherit (pkgs) awscli2 jq openssl ripgrep;
    in {
      node-pnpm-toolchain = pkgs.runCommand "node-pnpm-toolchain" {} ''
        test "$(${nodejs}/bin/node --eval 'process.stdout.write(process.versions.node.split(".")[0])')" = 26
        grep --fixed-strings '${nodejs}/bin/node ${corepack}/dist/pnpm.js' ${pnpm}/bin/pnpm
        ${awscli2}/bin/aws --version
        ${jq}/bin/jq --version
        ${ripgrep}/bin/rg --version
        ${openssl}/bin/openssl version
        touch $out
      '';
    });
    devShells = forAllSystems (pkgs: let
      inherit (nodeToolchain pkgs) nodejs pnpm pnpx;
    in {
      default = pkgs.mkShell {
        packages = with pkgs; [
          awscli2
          bun
          deno
          git
          jq
          nodejs
          pnpm
          pnpx
          python3
          ripgrep
          openssl
        ];
        shellHook = ''
          # Security-sensitive path tests require the shell-provided temp root
          # to use its physical spelling (for example /private/tmp on macOS).
          export TMPDIR="$(${pkgs.coreutils}/bin/realpath -- "$TMPDIR")"
        '';
      };
    });
  };
}
