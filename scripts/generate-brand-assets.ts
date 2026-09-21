import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(__dirname, "..");
const BRANDS_DIR = path.join(ROOT, "brands");
const THEMES_DIR = path.join(ROOT, "themes");
const ASSETS_DIR = path.join(ROOT, "packages/shell/assets");
const MOCKS_DIR = path.join(ROOT, "odocs/architecture/mocks");

// Ensure directories exist
for (const dir of [
  BRANDS_DIR,
  THEMES_DIR,
  path.join(THEMES_DIR, "staka-dark/backgrounds"),
  path.join(THEMES_DIR, "staka-light/backgrounds"),
  ASSETS_DIR,
  MOCKS_DIR,
]) {
  fs.mkdirSync(dir, { recursive: true });
}

console.log("Creating high-end Staka brand assets and wallpapers...");

// --------------------------------------------------------------------------
// 1. Core Brand SVGs
// --------------------------------------------------------------------------

// 64x64 Mark (stacked-S silhouette with precise proportions & gradients)
const stakaMarkSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none" role="img" aria-label="Staka">
  <defs>
    <linearGradient id="sm-top" x1="10" y1="8" x2="46" y2="20" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#3B7BFF"/>
      <stop offset="100%" stop-color="#1E5EFF"/>
    </linearGradient>
    <linearGradient id="sm-mid" x1="18" y1="26" x2="54" y2="38" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#609AFF"/>
      <stop offset="100%" stop-color="#3B7BFF"/>
    </linearGradient>
    <linearGradient id="sm-bot" x1="10" y1="44" x2="46" y2="56" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#1E5EFF"/>
      <stop offset="100%" stop-color="#0B2F8A"/>
    </linearGradient>
    <filter id="sm-shadow" x="6" y="6" width="52" height="54" filterUnits="userSpaceOnUse">
      <feDropShadow dx="0" dy="2" stdDeviation="2" flood-color="#0B1220" flood-opacity="0.4"/>
    </filter>
  </defs>
  <g filter="url(#sm-shadow)">
    <rect x="10" y="8" width="36" height="12" rx="3.5" fill="url(#sm-top)"/>
    <rect x="18" y="26" width="36" height="12" rx="3.5" fill="url(#sm-mid)"/>
    <rect x="10" y="44" width="36" height="12" rx="3.5" fill="url(#sm-bot)"/>
  </g>
</svg>`;

// Monochrome version
const stakaMarkMonoSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none" role="img" aria-label="Staka Monochrome">
  <rect x="10" y="8" width="36" height="12" rx="3.5" fill="currentColor"/>
  <rect x="18" y="26" width="36" height="12" rx="3.5" fill="currentColor"/>
  <rect x="10" y="44" width="36" height="12" rx="3.5" fill="currentColor"/>
</svg>`;

// Full Wordmark with modern geometric typography
const stakaWordmarkSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 280 64" fill="none" role="img" aria-label="Staka">
  <defs>
    <linearGradient id="wm-top" x1="4" y1="8" x2="40" y2="20" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#3B7BFF"/>
      <stop offset="100%" stop-color="#1E5EFF"/>
    </linearGradient>
    <linearGradient id="wm-mid" x1="12" y1="26" x2="48" y2="38" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#609AFF"/>
      <stop offset="100%" stop-color="#3B7BFF"/>
    </linearGradient>
    <linearGradient id="wm-bot" x1="4" y1="44" x2="40" y2="56" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#1E5EFF"/>
      <stop offset="100%" stop-color="#0B2F8A"/>
    </linearGradient>
    <style>
      .wm-text { fill: #E6ECF8; font-family: 'Inter', system-ui, -apple-system, BlinkMacSystemFont, sans-serif; font-size: 38px; font-weight: 700; letter-spacing: -0.04em; }
      @media (prefers-color-scheme: light) {
        .wm-text { fill: #0B1220; }
      }
    </style>
  </defs>
  <g>
    <rect x="4" y="8" width="36" height="12" rx="3.5" fill="url(#wm-top)"/>
    <rect x="12" y="26" width="36" height="12" rx="3.5" fill="url(#wm-mid)"/>
    <rect x="4" y="44" width="36" height="12" rx="3.5" fill="url(#wm-bot)"/>
    <text class="wm-text" x="62" y="44">staka</text>
  </g>
</svg>`;

// App Icon / Squircle 512x512
const stakaIconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" fill="none">
  <defs>
    <radialGradient id="icon-bg-glow" cx="50%" cy="30%" r="70%">
      <stop offset="0%" stop-color="#162544"/>
      <stop offset="100%" stop-color="#070B14"/>
    </radialGradient>
    <linearGradient id="icon-border" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#3B7BFF" stop-opacity="0.4"/>
      <stop offset="100%" stop-color="#0B2F8A" stop-opacity="0.2"/>
    </linearGradient>
    <linearGradient id="bar1" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#3B7BFF"/>
      <stop offset="100%" stop-color="#1E5EFF"/>
    </linearGradient>
    <linearGradient id="bar2" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#609AFF"/>
      <stop offset="100%" stop-color="#3B7BFF"/>
    </linearGradient>
    <linearGradient id="bar3" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#1E5EFF"/>
      <stop offset="100%" stop-color="#0B2F8A"/>
    </linearGradient>
    <filter id="icon-glow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="8" stdDeviation="16" flood-color="#1E5EFF" flood-opacity="0.35"/>
    </filter>
  </defs>
  <!-- Background Squircle -->
  <rect x="16" y="16" width="480" height="480" rx="108" fill="url(#icon-bg-glow)"/>
  <rect x="16" y="16" width="480" height="480" rx="108" stroke="url(#icon-border)" stroke-width="4"/>

  <!-- Centered Insignia -->
  <g filter="url(#icon-glow)" transform="translate(116, 126)">
    <rect x="0" y="0" width="220" height="70" rx="20" fill="url(#bar1)"/>
    <rect x="60" y="95" width="220" height="70" rx="20" fill="url(#bar2)"/>
    <rect x="0" y="190" width="220" height="70" rx="20" fill="url(#bar3)"/>
  </g>
</svg>`;

// Verified ASCII Logo matching boot screen
const stakaLogoTxt = ` ███████╗████████╗ █████╗ ██╗  ██╗ █████╗
 ██╔════╝╚══██╔══╝██╔══██╗██║ ██╔╝██╔══██╗
 ███████╗   ██║   ███████║█████╔╝ ███████║
 ╚════██║   ██║   ██╔══██║██╔═██╗ ██╔══██║
 ███████║   ██║   ██║  ██║██║  ██╗██║  ██║
 ╚══════╝   ╚═╝   ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝
`;

fs.writeFileSync(path.join(BRANDS_DIR, "staka-mark.svg"), stakaMarkSvg);
fs.writeFileSync(path.join(BRANDS_DIR, "staka-mark-mono.svg"), stakaMarkMonoSvg);
fs.writeFileSync(path.join(BRANDS_DIR, "staka-wordmark.svg"), stakaWordmarkSvg);
fs.writeFileSync(path.join(BRANDS_DIR, "staka-icon.svg"), stakaIconSvg);
fs.writeFileSync(path.join(BRANDS_DIR, "staka-logo.txt"), stakaLogoTxt);

// --------------------------------------------------------------------------
// 2. High-End Wallpapers
// --------------------------------------------------------------------------

// Wallpaper Dark (2560x1440 master SVG with dark blue glass, ambient neon glows, grid)
function generateWallpaperDarkSvg(width = 2560, height = 1440): string {
  const scale = width / 2560;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" fill="none">
  <defs>
    <!-- Background Gradient -->
    <linearGradient id="bg-grad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#070B14"/>
      <stop offset="45%" stop-color="#0B1220"/>
      <stop offset="100%" stop-color="#04070D"/>
    </linearGradient>

    <!-- Ambient Glows -->
    <radialGradient id="neon-glow-primary" cx="75%" cy="25%" r="65%">
      <stop offset="0%" stop-color="#1E5EFF" stop-opacity="0.22"/>
      <stop offset="50%" stop-color="#0B2F8A" stop-opacity="0.08"/>
      <stop offset="100%" stop-color="#0B1220" stop-opacity="0"/>
    </radialGradient>

    <radialGradient id="neon-glow-secondary" cx="20%" cy="80%" r="60%">
      <stop offset="0%" stop-color="#0B2F8A" stop-opacity="0.30"/>
      <stop offset="60%" stop-color="#070B14" stop-opacity="0"/>
    </radialGradient>

    <radialGradient id="center-soft" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#3B7BFF" stop-opacity="0.06"/>
      <stop offset="100%" stop-color="#070B14" stop-opacity="0"/>
    </radialGradient>

    <!-- Stacked S Bar Gradients -->
    <linearGradient id="bar-g1" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#3B7BFF" stop-opacity="0.18"/>
      <stop offset="100%" stop-color="#1E5EFF" stop-opacity="0.08"/>
    </linearGradient>
    <linearGradient id="bar-g2" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#609AFF" stop-opacity="0.24"/>
      <stop offset="100%" stop-color="#3B7BFF" stop-opacity="0.10"/>
    </linearGradient>
    <linearGradient id="bar-g3" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#1E5EFF" stop-opacity="0.16"/>
      <stop offset="100%" stop-color="#0B2F8A" stop-opacity="0.06"/>
    </linearGradient>

    <linearGradient id="stroke-g" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#3B7BFF" stop-opacity="0.3"/>
      <stop offset="100%" stop-color="#1E5EFF" stop-opacity="0.05"/>
    </linearGradient>

    <filter id="mark-glow" x="-30%" y="-30%" width="160%" height="160%">
      <feGaussianBlur stdDeviation="30" result="blur"/>
      <feComposite in="SourceGraphic" in2="blur" operator="over"/>
    </filter>
  </defs>

  <!-- Canvas Background -->
  <rect width="${width}" height="${height}" fill="url(#bg-grad)"/>

  <!-- Ambient Lighting Layers -->
  <rect width="${width}" height="${height}" fill="url(#neon-glow-primary)"/>
  <rect width="${width}" height="${height}" fill="url(#neon-glow-secondary)"/>
  <rect width="${width}" height="${height}" fill="url(#center-soft)"/>

  <!-- Subtle Perspective Geometric Curves / Architectural Horizon -->
  <g stroke="url(#stroke-g)" stroke-width="1" opacity="0.6">
    <path d="M-100,${height * 0.85} Q${width * 0.3},${height * 0.65} ${width * 0.7},${height * 0.8} T${width + 100},${height * 0.7}" fill="none"/>
    <path d="M-100,${height * 0.90} Q${width * 0.35},${height * 0.70} ${width * 0.75},${height * 0.85} T${width + 100},${height * 0.75}" fill="none" opacity="0.5"/>
    <path d="M-100,${height * 0.95} Q${width * 0.4},${height * 0.75} ${width * 0.8},${height * 0.9} T${width + 100},${height * 0.8}" fill="none" opacity="0.3"/>
  </g>

  <!-- Large Central Watermark Stacked-S Symbol -->
  <g transform="translate(${width * 0.5 - 280 * scale}, ${height * 0.5 - 200 * scale}) scale(${scale})">
    <!-- Outer ambient aura behind the bars -->
    <rect x="-40" y="-30" width="640" height="460" rx="80" fill="#1E5EFF" opacity="0.03" filter="url(#mark-glow)"/>

    <!-- Bar 1 (Top) -->
    <rect x="0" y="0" width="460" height="110" rx="32" fill="url(#bar-g1)" stroke="url(#stroke-g)" stroke-width="1.5"/>

    <!-- Bar 2 (Middle, offset right) -->
    <rect x="100" y="145" width="460" height="110" rx="32" fill="url(#bar-g2)" stroke="url(#stroke-g)" stroke-width="1.5"/>

    <!-- Bar 3 (Bottom) -->
    <rect x="0" y="290" width="460" height="110" rx="32" fill="url(#bar-g3)" stroke="url(#stroke-g)" stroke-width="1.5"/>

    <!-- Micro-accent: subtle corner specular dots -->
    <circle cx="28" cy="28" r="3" fill="#609AFF" opacity="0.6"/>
    <circle cx="128" cy="173" r="3" fill="#609AFF" opacity="0.6"/>
    <circle cx="28" cy="318" r="3" fill="#609AFF" opacity="0.6"/>
  </g>

  <!-- Minimal Brand Corner / Frame Signature -->
  <g transform="translate(${width - 240 * scale}, ${height - 80 * scale}) scale(${scale})" opacity="0.45">
    <text font-family="'Inter', sans-serif" font-size="14" font-weight="600" letter-spacing="0.2em" fill="#7C8AA5">STAKA OS</text>
  </g>
</svg>`;
}

// Wallpaper Dusk (deep saturated blue variant)
function generateWallpaperDuskSvg(width = 2560, height = 1440): string {
  const scale = width / 2560;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" fill="none">
  <defs>
    <linearGradient id="dusk-bg" x1="20%" y1="0%" x2="80%" y2="100%">
      <stop offset="0%" stop-color="#081026"/>
      <stop offset="50%" stop-color="#0B1B3D"/>
      <stop offset="100%" stop-color="#050A17"/>
    </linearGradient>
    <radialGradient id="dusk-glow" cx="80%" cy="30%" r="60%">
      <stop offset="0%" stop-color="#1E5EFF" stop-opacity="0.30"/>
      <stop offset="40%" stop-color="#0B2F8A" stop-opacity="0.15"/>
      <stop offset="100%" stop-color="#050A17" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="dusk-bar1" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#3B7BFF" stop-opacity="0.25"/>
      <stop offset="100%" stop-color="#1E5EFF" stop-opacity="0.10"/>
    </linearGradient>
    <linearGradient id="dusk-bar2" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#609AFF" stop-opacity="0.30"/>
      <stop offset="100%" stop-color="#3B7BFF" stop-opacity="0.12"/>
    </linearGradient>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#dusk-bg)"/>
  <rect width="${width}" height="${height}" fill="url(#dusk-glow)"/>

  <!-- Centered insignia watermark -->
  <g transform="translate(${width * 0.5 - 280 * scale}, ${height * 0.5 - 200 * scale}) scale(${scale})">
    <rect x="0" y="0" width="460" height="110" rx="32" fill="url(#dusk-bar1)" stroke="#3B7BFF" stroke-opacity="0.25" stroke-width="1.5"/>
    <rect x="100" y="145" width="460" height="110" rx="32" fill="url(#dusk-bar2)" stroke="#609AFF" stroke-opacity="0.35" stroke-width="1.5"/>
    <rect x="0" y="290" width="460" height="110" rx="32" fill="url(#dusk-bar1)" stroke="#1E5EFF" stroke-opacity="0.25" stroke-width="1.5"/>
  </g>
</svg>`;
}

// Wallpaper Light (crisp 2560x1440)
function generateWallpaperLightSvg(width = 2560, height = 1440): string {
  const scale = width / 2560;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" fill="none">
  <defs>
    <linearGradient id="light-bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#FFFFFF"/>
      <stop offset="50%" stop-color="#F5F8FF"/>
      <stop offset="100%" stop-color="#EBF1FD"/>
    </linearGradient>
    <radialGradient id="light-glow" cx="80%" cy="20%" r="65%">
      <stop offset="0%" stop-color="#3B7BFF" stop-opacity="0.12"/>
      <stop offset="100%" stop-color="#FFFFFF" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="light-stroke" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#1E5EFF" stop-opacity="0.25"/>
      <stop offset="100%" stop-color="#3B7BFF" stop-opacity="0.08"/>
    </linearGradient>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#light-bg)"/>
  <rect width="${width}" height="${height}" fill="url(#light-glow)"/>

  <g transform="translate(${width * 0.5 - 280 * scale}, ${height * 0.5 - 200 * scale}) scale(${scale})">
    <rect x="0" y="0" width="460" height="110" rx="32" fill="#1E5EFF" fill-opacity="0.06" stroke="url(#light-stroke)" stroke-width="1.5"/>
    <rect x="100" y="145" width="460" height="110" rx="32" fill="#3B7BFF" fill-opacity="0.08" stroke="url(#light-stroke)" stroke-width="1.5"/>
    <rect x="0" y="290" width="460" height="110" rx="32" fill="#0B2F8A" fill-opacity="0.05" stroke="url(#light-stroke)" stroke-width="1.5"/>
  </g>
</svg>`;
}

// Lock Screen Wallpaper (blurred / darkened with prominent glowing insignia)
function generateLockWallpaperSvg(width = 2560, height = 1440): string {
  const scale = width / 2560;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" fill="none">
  <defs>
    <linearGradient id="lock-bg" x1="50%" y1="0%" x2="50%" y2="100%">
      <stop offset="0%" stop-color="#050811"/>
      <stop offset="50%" stop-color="#080F1E"/>
      <stop offset="100%" stop-color="#03050A"/>
    </linearGradient>
    <radialGradient id="lock-radial" cx="50%" cy="45%" r="55%">
      <stop offset="0%" stop-color="#1E5EFF" stop-opacity="0.25"/>
      <stop offset="40%" stop-color="#0B2F8A" stop-opacity="0.10"/>
      <stop offset="100%" stop-color="#000000" stop-opacity="0"/>
    </radialGradient>
    <filter id="lock-aura" x="-40%" y="-40%" width="180%" height="180%">
      <feGaussianBlur stdDeviation="24" result="blur"/>
      <feMerge>
        <feMergeNode in="blur"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#lock-bg)"/>
  <rect width="${width}" height="${height}" fill="url(#lock-radial)"/>

  <!-- Centered Staka Symbol + Lock Aura -->
  <g filter="url(#lock-aura)" transform="translate(${width * 0.5 - 180 * scale}, ${height * 0.42 - 130 * scale}) scale(${scale * 0.8})">
    <rect x="0" y="0" width="360" height="90" rx="24" fill="#3B7BFF" fill-opacity="0.8"/>
    <rect x="90" y="115" width="360" height="90" rx="24" fill="#609AFF" fill-opacity="0.9"/>
    <rect x="0" y="230" width="360" height="90" rx="24" fill="#1E5EFF" fill-opacity="0.75"/>
  </g>
</svg>`;
}

// --------------------------------------------------------------------------
// 3. RD-M0 Shell Redesign Mockup (Visualizing the Band, Inset Windows, Dropping Lyrics)
// --------------------------------------------------------------------------

function generateShellRedesignMockSvg(width = 2560, height = 1440): string {
  const is1440p = width >= 1920;
  const scale = width / 2560;
  const bandThickness = is1440p ? 44 : 36;
  const margin = is1440p ? 14 : 10;
  const rounding = is1440p ? 14 : 10;

  // Window inside frame calculation
  const winX = bandThickness + margin + (is1440p ? 44 : 0); // left rail
  const winY = bandThickness + margin; // top band
  const winW = width - winX - margin;
  const winH = height - winY - margin;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" fill="none">
  <defs>
    <!-- Background Wallpaper embedded in mock -->
    <linearGradient id="mock-bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#070B14"/>
      <stop offset="50%" stop-color="#0B1220"/>
      <stop offset="100%" stop-color="#04070D"/>
    </linearGradient>
    <radialGradient id="mock-glow" cx="80%" cy="20%" r="60%">
      <stop offset="0%" stop-color="#1E5EFF" stop-opacity="0.18"/>
      <stop offset="100%" stop-color="#070B14" stop-opacity="0"/>
    </radialGradient>

    <!-- Shell Band Glass Gradient -->
    <linearGradient id="band-surface" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#111A2E" stop-opacity="0.94"/>
      <stop offset="100%" stop-color="#0D1525" stop-opacity="0.92"/>
    </linearGradient>

    <!-- Active Window Border Gradient -->
    <linearGradient id="win-border-active" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#1E5EFF"/>
      <stop offset="100%" stop-color="#3B7BFF"/>
    </linearGradient>

    <!-- Liquid Drop Shadow -->
    <filter id="drop-shadow" x="-20%" y="-20%" width="140%" height="150%">
      <feDropShadow dx="0" dy="16" stdDeviation="24" flood-color="#000000" flood-opacity="0.6"/>
      <feDropShadow dx="0" dy="4" stdDeviation="8" flood-color="#1E5EFF" flood-opacity="0.25"/>
    </filter>

    <style>
      text { font-family: 'Inter', -apple-system, system-ui, sans-serif; }
      .pill { rx: 6px; }
    </style>
  </defs>

  <!-- 1. BASE DESKTOP WALLPAPER -->
  <rect width="${width}" height="${height}" fill="url(#mock-bg)"/>
  <rect width="${width}" height="${height}" fill="url(#mock-glow)"/>

  <!-- Subtle watermark on desktop -->
  <g transform="translate(${width * 0.55}, ${height * 0.45}) scale(${scale * 0.6})" opacity="0.1">
    <rect x="0" y="0" width="460" height="110" rx="32" fill="#1E5EFF"/>
    <rect x="100" y="145" width="460" height="110" rx="32" fill="#3B7BFF"/>
    <rect x="0" y="290" width="460" height="110" rx="32" fill="#0B2F8A"/>
  </g>

  <!-- 2. INSET TILED WINDOW (Inside the Frame) -->
  <g>
    <!-- Window Border & Body -->
    <rect x="${winX}" y="${winY}" width="${winW}" height="${winH}" rx="${rounding}" fill="#0D1322" fill-opacity="0.96" stroke="url(#win-border-active)" stroke-width="2.5"/>

    <!-- Window Titlebar / Interior Header -->
    <rect x="${winX}" y="${winY}" width="${winW}" height="38" rx="${rounding}" fill="#111A2E" fill-opacity="0.8"/>
    <!-- Window Controls / Dots -->
    <circle cx="${winX + 20}" cy="${winY + 19}" r="5.5" fill="#D64545"/>
    <circle cx="${winX + 38}" cy="${winY + 19}" r="5.5" fill="#D29922"/>
    <circle cx="${winX + 56}" cy="${winY + 19}" r="5.5" fill="#3FB950"/>
    <text x="${winX + 80}" y="${winY + 24}" font-size="13" font-weight="500" fill="#7C8AA5">cloudsurfer@staka: ~/projects/stakaos (zsh)</text>

    <!-- Terminal Code / Neovim Content Mock -->
    <g transform="translate(${winX + 24}, ${winY + 64})" font-family="'JetBrains Mono', 'Fira Code', monospace" font-size="13.5" fill="#E6ECF8">
      <text y="0" fill="#7C8AA5"># Staka Shell Redesign v1 - The Band Architecture</text>
      <text y="24" fill="#3B7BFF">import</text><text x="60" y="24"> { BandCoupler, BandDrop } </text><text x="270" y="24" fill="#3B7BFF">from</text><text x="315" y="24" fill="#3FB950"> "qs.Commons"</text>
      <text y="54" fill="#7C8AA5">// Hyprland coupling: windows inset inside continuous perimeter frame</text>
      <text y="78"><tspan fill="#3B7BFF">const</tspan> bandConfig = {</text>
      <text y="102" fill="#E6ECF8">  edges: [<tspan fill="#3FB950">"top"</tspan>, <tspan fill="#3FB950">"left"</tspan>],</text>
      <text y="126" fill="#E6ECF8">  thickness: <tspan fill="#D29922">${bandThickness}</tspan>,</text>
      <text y="150" fill="#E6ECF8">  activeBorder: <tspan fill="#3FB950">"rgba(1E5EFFee) rgba(3B7BFFee) 45deg"</tspan>,</text>
      <text y="174" fill="#E6ECF8">  dropAnimation: <tspan fill="#3FB950">"liquid-spring-280ms"</tspan></text>
      <text y="198">};</text>
      <text y="238" fill="#3FB950">✔ Compositor connected to /run/user/1000/staka/compositor.sock</text>
      <text y="262" fill="#3B7BFF">★ Liquid-drop popup engine initialized (anchor: nearest-rail)</text>
    </g>
  </g>

  <!-- 3. PERIMETER BAND (Top Band Edge-to-Edge) -->
  <g>
    <!-- Top Band Surface -->
    <rect x="0" y="0" width="${width}" height="${bandThickness}" fill="url(#band-surface)"/>
    <line x1="0" y1="${bandThickness}" x2="${width}" y2="${bandThickness}" stroke="#1E2A44" stroke-width="1"/>

    <!-- Left Rail Surface (Optional vertical rail) -->
    ${
      is1440p
        ? `<rect x="0" y="${bandThickness}" width="44" height="${height - bandThickness}" fill="url(#band-surface)"/>
         <line x1="44" y1="${bandThickness}" x2="44" y2="${height}" stroke="#1E2A44" stroke-width="1"/>
         <!-- Left Rail Compact Dots -->
         <g transform="translate(18, 60)">
           <circle cy="0" r="4" fill="#1E5EFF"/>
           <circle cy="24" r="3" fill="#7C8AA5" opacity="0.6"/>
           <circle cy="48" r="3" fill="#7C8AA5" opacity="0.6"/>
           <circle cy="72" r="3" fill="#7C8AA5" opacity="0.6"/>
         </g>`
        : ""
    }

    <!-- Top Band Modules: Left Section -->
    <g transform="translate(16, ${(bandThickness - 26) / 2})">
      <!-- Staka Brand Mark Small -->
      <g transform="translate(0, 3) scale(0.32)">
        <rect x="0" y="0" width="36" height="12" rx="3.5" fill="#3B7BFF"/>
        <rect x="8" y="18" width="36" height="12" rx="3.5" fill="#609AFF"/>
        <rect x="0" y="36" width="36" height="12" rx="3.5" fill="#1E5EFF"/>
      </g>

      <!-- Workspace Pills -->
      <g transform="translate(32, 0)">
        <!-- Workspace 1 (Active) -->
        <rect x="0" y="0" width="28" height="26" rx="6" fill="#1E5EFF"/>
        <text x="14" y="17" font-size="12" font-weight="700" fill="#FFFFFF" text-anchor="middle">1</text>

        <!-- Inactive Workspaces -->
        <rect x="34" y="0" width="24" height="26" rx="6" fill="#16213A" fill-opacity="0.8"/>
        <text x="46" y="17" font-size="12" font-weight="500" fill="#7C8AA5" text-anchor="middle">2</text>

        <rect x="64" y="0" width="24" height="26" rx="6" fill="#16213A" fill-opacity="0.8"/>
        <text x="76" y="17" font-size="12" font-weight="500" fill="#7C8AA5" text-anchor="middle">3</text>

        <rect x="94" y="0" width="24" height="26" rx="6" fill="#16213A" fill-opacity="0.8"/>
        <text x="106" y="17" font-size="12" font-weight="500" fill="#7C8AA5" text-anchor="middle">4</text>
      </g>

      <!-- Active Window Ticker Title -->
      <g transform="translate(170, 0)">
        <rect x="0" y="0" width="260" height="26" rx="6" fill="#16213A" fill-opacity="0.6" stroke="#1E2A44" stroke-width="1"/>
        <circle cx="14" cy="13" r="4" fill="#3FB950"/>
        <text x="26" y="17" font-size="12" font-weight="500" fill="#E6ECF8">kitty: ~/projects/stakaos</text>
      </g>

      <!-- Inline lyrics teaser pill in bar -->
      <g transform="translate(440, 0)">
        <rect x="0" y="0" width="240" height="26" rx="6" fill="#16213A" fill-opacity="0.6" stroke="#1E2A44" stroke-width="1"/>
        <text x="12" y="17" font-size="12" font-weight="500" fill="#3B7BFF">♪  Neon lights reflect in rain</text>
      </g>
    </g>

    <!-- Top Band Modules: Center Section -->
    <g transform="translate(${width * 0.5 - 130}, ${(bandThickness - 26) / 2})">
      <rect x="0" y="0" width="260" height="26" rx="6" fill="#16213A" fill-opacity="0.7" stroke="#1E2A44" stroke-width="1"/>
      <text x="130" y="17" font-size="12.5" font-weight="600" fill="#E6ECF8" text-anchor="middle">Mon 21 Sep  23:48  •  22°C Clear</text>
    </g>

    <!-- Top Band Modules: Right Section (System Stats, AI Agent, Audio, Power) -->
    <g transform="translate(${width - 480}, ${(bandThickness - 26) / 2})">
      <!-- RAM / CPU Stats Mode: labels -->
      <rect x="0" y="0" width="135" height="26" rx="6" fill="#16213A" fill-opacity="0.6" stroke="#1E2A44" stroke-width="1"/>
      <text x="10" y="17" font-size="11.5" font-weight="600" fill="#7C8AA5">CPU <tspan fill="#3B7BFF">14%</tspan>  RAM <tspan fill="#3B7BFF">4.2G</tspan></text>

      <!-- AI Panel Toggle Pill -->
      <g transform="translate(145, 0)">
        <rect x="0" y="0" width="80" height="26" rx="6" fill="#1E5EFF" fill-opacity="0.2" stroke="#1E5EFF" stroke-width="1"/>
        <text x="40" y="17" font-size="11.5" font-weight="700" fill="#609AFF" text-anchor="middle">✦ AGENT</text>
      </g>

      <!-- Network / Volume / Battery / Power -->
      <g transform="translate(235, 0)">
        <rect x="0" y="0" width="180" height="26" rx="6" fill="#16213A" fill-opacity="0.6" stroke="#1E2A44" stroke-width="1"/>
        <text x="90" y="17" font-size="12" font-weight="500" fill="#E6ECF8" text-anchor="middle">📶  🔊 82%  🔋 100%  ⏻</text>
      </g>
    </g>
  </g>

  <!-- 4. LIQUID-DROP WIDGET: Media Player & Synchronized Lyrics Drop-Out -->
  <!-- Anchored to the top band right beneath the lyrics indicator -->
  <g transform="translate(430, ${bandThickness + 10})" filter="url(#drop-shadow)">
    <!-- Droplet Neck Connector (Liquid Drop Visual) -->
    <path d="M120,-10 C120,-4 110,0 90,0 L260,0 C240,0 230,-4 230,-10 Z" fill="#111A2E" opacity="0.95"/>

    <!-- Main Drop Card Surface -->
    <rect x="0" y="0" width="380" height="340" rx="16" fill="#111A2E" fill-opacity="0.96" stroke="#1E5EFF" stroke-opacity="0.6" stroke-width="1.5"/>

    <!-- Header / Track Details -->
    <g transform="translate(18, 18)">
      <!-- Album Art Squircle -->
      <rect x="0" y="0" width="68" height="68" rx="12" fill="#16213A" stroke="#1E2A44" stroke-width="1"/>
      <!-- Album Vinyl Icon -->
      <circle cx="34" cy="34" r="24" fill="#0B1220"/>
      <circle cx="34" cy="34" r="8" fill="#1E5EFF"/>

      <!-- Track Info -->
      <text x="82" y="24" font-size="14.5" font-weight="700" fill="#E6ECF8">Midnight Resonance</text>
      <text x="82" y="44" font-size="12.5" font-weight="500" fill="#7C8AA5">Staka Soundworks — OST</text>

      <!-- Seek Bar -->
      <g transform="translate(0, 84)">
        <rect x="0" y="0" width="344" height="5" rx="2.5" fill="#1E2A44"/>
        <rect x="0" y="0" width="140" height="5" rx="2.5" fill="#1E5EFF"/>
        <circle cx="140" cy="2.5" r="5" fill="#3B7BFF"/>
        <text x="0" y="20" font-size="11" fill="#7C8AA5">01:42</text>
        <text x="344" y="20" font-size="11" fill="#7C8AA5" text-anchor="end">03:58</text>
      </g>

      <!-- Transport Controls -->
      <g transform="translate(90, 114)">
        <text x="0" y="16" font-size="18" fill="#7C8AA5">⏮</text>
        <circle cx="50" cy="12" r="16" fill="#1E5EFF"/>
        <text x="50" y="17" font-size="14" fill="#FFFFFF" text-anchor="middle">⏸</text>
        <text x="100" y="16" font-size="18" fill="#7C8AA5">⏭</text>
      </g>
    </g>

    <!-- Synchronized Lyrics Scroll Container -->
    <g transform="translate(18, 185)">
      <rect x="0" y="0" width="344" height="135" rx="10" fill="#0B1220" fill-opacity="0.6" stroke="#1E2A44" stroke-width="1"/>

      <!-- Lyric lines -->
      <text x="16" y="28" font-size="12.5" fill="#7C8AA5" opacity="0.5">[01:30] Floating above the silent grid</text>

      <!-- Active Lyric Highlight with Glowing Capsule -->
      <rect x="8" y="40" width="328" height="28" rx="6" fill="#1E5EFF" fill-opacity="0.18" stroke="#3B7BFF" stroke-opacity="0.4" stroke-width="1"/>
      <text x="16" y="59" font-size="13.5" font-weight="700" fill="#609AFF">[01:42] Neon lights reflect in rain</text>

      <text x="16" y="92" font-size="12.5" fill="#7C8AA5">[01:54] Signals crossing through the band</text>
      <text x="16" y="118" font-size="12.5" fill="#7C8AA5" opacity="0.5">[02:08] A unified horizon waits</text>
    </g>
  </g>
</svg>`;
}

// --------------------------------------------------------------------------
// Write all SVGs
// --------------------------------------------------------------------------

const wpDarkSvg = generateWallpaperDarkSvg(2560, 1440);
const wpDuskSvg = generateWallpaperDuskSvg(2560, 1440);
const wpLightSvg = generateWallpaperLightSvg(2560, 1440);
const wpLockSvg = generateLockWallpaperSvg(2560, 1440);
const mock1440Svg = generateShellRedesignMockSvg(2560, 1440);
const mock768Svg = generateShellRedesignMockSvg(1366, 768);

fs.writeFileSync(path.join(BRANDS_DIR, "wallpaper-dark.svg"), wpDarkSvg);
fs.writeFileSync(path.join(BRANDS_DIR, "wallpaper-dusk.svg"), wpDuskSvg);
fs.writeFileSync(path.join(BRANDS_DIR, "wallpaper-light.svg"), wpLightSvg);
fs.writeFileSync(path.join(BRANDS_DIR, "lock-wallpaper.svg"), wpLockSvg);

fs.writeFileSync(path.join(MOCKS_DIR, "rd-m0-mock-2560x1440.svg"), mock1440Svg);
fs.writeFileSync(path.join(MOCKS_DIR, "rd-m0-mock-1366x768.svg"), mock768Svg);

// --------------------------------------------------------------------------
// 4. Render to Crisp High-Res PNGs using rsvg-convert
// --------------------------------------------------------------------------

function renderPng(svgPath: string, pngPath: string, width: number, height: number) {
  try {
    execSync(`rsvg-convert -w ${width} -h ${height} "${svgPath}" -o "${pngPath}"`);
    console.log(`Rendered: ${path.basename(pngPath)} (${width}x${height})`);
  } catch (e) {
    console.error(`Error rendering ${pngPath}:`, e);
  }
}

console.log("\nRendering PNGs...");

// Brand Icon variants
renderPng(path.join(BRANDS_DIR, "staka-icon.svg"), path.join(BRANDS_DIR, "staka-icon-512.png"), 512, 512);
renderPng(path.join(BRANDS_DIR, "staka-icon.svg"), path.join(BRANDS_DIR, "staka-icon-256.png"), 256, 256);
renderPng(path.join(BRANDS_DIR, "staka-icon.svg"), path.join(BRANDS_DIR, "staka-icon-128.png"), 128, 128);
fs.copyFileSync(path.join(BRANDS_DIR, "staka-icon-512.png"), path.join(BRANDS_DIR, "icon.png"));

// Wallpapers: Dark
renderPng(path.join(BRANDS_DIR, "wallpaper-dark.svg"), path.join(BRANDS_DIR, "wallpaper-dark-2560x1440.png"), 2560, 1440);
renderPng(path.join(BRANDS_DIR, "wallpaper-dark.svg"), path.join(BRANDS_DIR, "wallpaper-dark-1920x1080.png"), 1920, 1080);
renderPng(path.join(BRANDS_DIR, "wallpaper-dark.svg"), path.join(BRANDS_DIR, "wallpaper-dark-1366x768.png"), 1366, 768);

// Wallpapers: Dusk
renderPng(path.join(BRANDS_DIR, "wallpaper-dusk.svg"), path.join(BRANDS_DIR, "wallpaper-dusk-2560x1440.png"), 2560, 1440);
renderPng(path.join(BRANDS_DIR, "wallpaper-dusk.svg"), path.join(BRANDS_DIR, "wallpaper-dusk-1920x1080.png"), 1920, 1080);

// Wallpapers: Light
renderPng(path.join(BRANDS_DIR, "wallpaper-light.svg"), path.join(BRANDS_DIR, "wallpaper-light-2560x1440.png"), 2560, 1440);
renderPng(path.join(BRANDS_DIR, "wallpaper-light.svg"), path.join(BRANDS_DIR, "wallpaper-light-1920x1080.png"), 1920, 1080);

// Lock screen
renderPng(path.join(BRANDS_DIR, "lock-wallpaper.svg"), path.join(BRANDS_DIR, "lock-wallpaper-2560x1440.png"), 2560, 1440);
fs.copyFileSync(path.join(BRANDS_DIR, "lock-wallpaper-2560x1440.png"), path.join(BRANDS_DIR, "lock-wallpaper.png"));

// Theme Backgrounds
const darkBgDir = path.join(THEMES_DIR, "staka-dark/backgrounds");
const lightBgDir = path.join(THEMES_DIR, "staka-light/backgrounds");

fs.copyFileSync(path.join(BRANDS_DIR, "wallpaper-dark-2560x1440.png"), path.join(darkBgDir, "0-staka-dark.png"));
fs.copyFileSync(path.join(BRANDS_DIR, "wallpaper-dusk-2560x1440.png"), path.join(darkBgDir, "1-staka-dusk.png"));
fs.copyFileSync(path.join(BRANDS_DIR, "wallpaper-dark-1920x1080.png"), path.join(THEMES_DIR, "staka-dark/preview.png"));
fs.copyFileSync(path.join(BRANDS_DIR, "lock-wallpaper.png"), path.join(THEMES_DIR, "staka-dark/unlock.png"));

fs.copyFileSync(path.join(BRANDS_DIR, "wallpaper-light-2560x1440.png"), path.join(lightBgDir, "0-staka-light.png"));
fs.copyFileSync(path.join(BRANDS_DIR, "wallpaper-light-1920x1080.png"), path.join(THEMES_DIR, "staka-light/preview.png"));
fs.copyFileSync(path.join(BRANDS_DIR, "wallpaper-light-2560x1440.png"), path.join(THEMES_DIR, "staka-light/unlock.png"));

// RD-M0 Mocks
renderPng(path.join(MOCKS_DIR, "rd-m0-mock-2560x1440.svg"), path.join(MOCKS_DIR, "rd-m0-mock-2560x1440.png"), 2560, 1440);
renderPng(path.join(MOCKS_DIR, "rd-m0-mock-1366x768.svg"), path.join(MOCKS_DIR, "rd-m0-mock-1366x768.png"), 1366, 768);

console.log("\nAll brand assets, wallpapers, themes, and RD-M0 mocks generated successfully!");
