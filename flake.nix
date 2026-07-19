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
      nodejs = pkgs.nodejs_24;
      pnpm = pkgs.writeShellApplication {
        name = "pnpm";
        text = ''
          exec ${nodejs}/bin/corepack pnpm "$@"
        '';
      };
      pnpx = pkgs.writeShellApplication {
        name = "pnpx";
        text = ''
          exec ${nodejs}/bin/corepack pnpx "$@"
        '';
      };
    };
  in {
    formatter = forAllSystems (pkgs: pkgs.alejandra);
    checks = forAllSystems (pkgs: let
      inherit (nodeToolchain pkgs) nodejs pnpm;
    in {
      node-pnpm-toolchain = pkgs.runCommand "node-pnpm-toolchain" {} ''
        test "$(${nodejs}/bin/node --eval 'process.stdout.write(process.versions.node.split(".")[0])')" = 24
        grep --fixed-strings '${nodejs}/bin/corepack pnpm' ${pnpm}/bin/pnpm
        touch $out
      '';
    });
    devShells = forAllSystems (pkgs: let
      inherit (nodeToolchain pkgs) nodejs pnpm pnpx;
    in {
      default = pkgs.mkShell {
        packages = with pkgs; [
          bun
          deno
          nodejs
          pnpm
          pnpx
          python3
        ];
      };
    });
  };
}
