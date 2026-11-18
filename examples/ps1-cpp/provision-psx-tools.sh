#!/bin/bash
# Build the PS1 toolchain + install the headless emulator under /opt, offline
# (sources were copied in; the VM's proxy allow-list is unchanged).
# Mirrors nocturne/scripts/setup-wsl.sh + spawn-compiler.sh, minus downloads.
set -euxo pipefail
SRC=/root/psx-dl
PREFIX=/opt/psx/mipsel-none-elf
JOBS=$(nproc)
export DEBIAN_FRONTEND=noninteractive

apt-get install -y -q build-essential git wget curl bzip2 xz-utils cmake ninja-build pkg-config \
  bison flex texinfo libgmp-dev libmpfr-dev libmpc-dev python3 python3-pil python3-pytest \
  unzip libfuse2t64 libx11-xcb1 libxcb-dri3-0 >/dev/null

W=/root/psx-build; mkdir -p $W; cd $W

if [ ! -x $PREFIX/bin/mipsel-none-elf-as ]; then
  tar xzf $SRC/binutils-2.47.tar.gz
  cd binutils-2.47
  ./configure --target=mipsel-none-elf --disable-multilib --disable-nls --disable-werror --prefix=$PREFIX
  make -j$JOBS && make install-strip
  cd $W
fi

if [ ! -x $PREFIX/bin/mipsel-none-elf-g++ ]; then
  tar xzf $SRC/gcc-16.2.0.tar.gz
  mkdir -p gcc-16.2.0/build && cd gcc-16.2.0/build
  # gmp/mpfr/mpc come from the system -dev packages instead of download_prerequisites.
  ../configure --target=mipsel-none-elf --without-isl --disable-nls --disable-threads --disable-shared \
    --disable-libssp --disable-libstdcxx-pch --disable-libgomp --disable-werror --without-headers \
    --disable-hosted-libstdcxx --with-as=$PREFIX/bin/mipsel-none-elf-as --with-ld=$PREFIX/bin/mipsel-none-elf-ld \
    --enable-languages=c,c++ --prefix=$PREFIX
  make -j$JOBS all-gcc && make install-strip-gcc
  make -j$JOBS all-target-libgcc && make install-strip-target-libgcc
  make -j$JOBS all-target-libstdc++-v3 && make install-strip-target-libstdc++-v3
  cd $W
fi

if [ ! -x /opt/psx/bin/mkpsxiso ]; then
  cp -a $SRC/mkpsxiso $W/mkpsxiso && cd $W/mkpsxiso
  cmake --preset release -DMKPSXISO_NO_LIBFLAC=1
  cmake --build --preset release
  cmake --install ./build --prefix /opt/psx
  cd $W
fi

if [ ! -x /opt/pcsx-redux/pcsx-redux ]; then
  cd $W && unzip -o -q $SRC/pcsx-redux-linux.zip
  chmod +x PCSX-Redux-HEAD-x86_64.AppImage
  ./PCSX-Redux-HEAD-x86_64.AppImage --appimage-extract >/dev/null
  mkdir -p /opt/pcsx-redux && cp -a squashfs-root /opt/pcsx-redux/app
  printf '#!/bin/sh\nexec /opt/pcsx-redux/app/AppRun "$@"\n' > /opt/pcsx-redux/pcsx-redux
  chmod 755 /opt/pcsx-redux/pcsx-redux
fi

chmod -R a+rX /opt/psx /opt/pcsx-redux
$PREFIX/bin/mipsel-none-elf-g++ --version | head -1
/opt/psx/bin/mkpsxiso --help 2>&1 | head -1 || true
echo "PSX TOOLS DONE"
