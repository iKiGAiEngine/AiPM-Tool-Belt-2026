{pkgs}: {
  deps = [
    pkgs.chromium
    pkgs.cairo
    pkgs.pango
    pkgs.libjpeg
    pkgs.giflib
    pkgs.librsvg
    pkgs.pixman
    pkgs.pkg-config
  ];
}
