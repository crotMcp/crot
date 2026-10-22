/** First-party, offline design tokens shared by Control Center and the hosted portal. */
export const CROT_CSS = `
:root{color-scheme:dark;--bg:#090A0F;--surface:#11131C;--raised:#171A26;--border:rgba(255,255,255,.08);--text:#F4F4FB;--muted:#A9AFC4;--accent:#A5A7FF;--gradient:linear-gradient(135deg,#6366F1 0%,#8B5CF6 100%);--ready:#10B981;--warning:#F59E0B;--error:#EF4444;font:16px/1.5 Inter,-apple-system,BlinkMacSystemFont,system-ui,sans-serif;background:var(--bg);color:var(--text)}
*{box-sizing:border-box}body{margin:0}button,a,input{font:inherit}button,.button{min-height:44px;padding:10px 16px;border:1px solid var(--border);border-radius:10px;background:var(--raised);color:var(--text);cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;justify-content:center;gap:8px;font-weight:600}button:hover,.button:hover{background:#24283A;border-color:#666B95}button:disabled{opacity:.55;cursor:not-allowed}button:focus-visible,a:focus-visible,summary:focus-visible{outline:3px solid var(--accent);outline-offset:4px}button.primary,.button.primary{background:var(--gradient);border-color:#888AF5;color:#fff}button.danger{border-color:#F87171;color:#FCA5A5}.muted,.note{color:var(--muted)}p{margin:8px 0 16px}h1,h2,h3{line-height:1.2;letter-spacing:-.03em;margin:0 0 12px}h1{font-size:clamp(28px,4vw,42px)}h2{font-size:24px}h3{font-size:18px}a{color:var(--accent)}.eyebrow{text-transform:uppercase;letter-spacing:.14em;font-size:14px;font-weight:700;color:var(--accent)}.badge{display:inline-flex;align-items:center;gap:8px;min-height:30px;border:1px solid var(--border);padding:4px 10px;border-radius:8px;font-size:14px;font-weight:700;white-space:normal}.badge.ready:before,.badge.warning:before{content:'';width:7px;height:7px;flex-shrink:0;border-radius:50%;background:var(--ready);box-shadow:0 0 10px #10B98188}.badge.warning:before{background:var(--warning);box-shadow:0 0 10px #F59E0B88}.badge.warning{color:#FCD38A}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.panel,.module,.capability{border:1px solid var(--border);border-radius:16px;background:var(--surface);padding:24px;min-width:0}.panel{margin-bottom:20px}.module{display:flex;flex-direction:column;gap:10px}.module svg,.capability svg{width:24px;height:24px;color:var(--accent);margin-bottom:8px}.actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:16px}.brand{display:flex;align-items:center;gap:12px;font-size:20px;font-weight:800;letter-spacing:.1em}.brand-mark{display:grid;place-items:center;flex-shrink:0;width:40px;height:40px;border-radius:12px;background:var(--gradient);letter-spacing:0}.topbar{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;padding:20px 28px;border-bottom:1px solid var(--border);background:var(--surface)}.topbar .actions{margin:0}.shell{max-width:1400px;margin:auto;display:grid;grid-template-columns:220px minmax(0,1fr);min-height:calc(100vh - 85px)}.sidebar{border-right:1px solid var(--border);padding:28px 16px;display:flex;flex-direction:column;gap:8px}.sidebar button{justify-content:flex-start;background:transparent;color:var(--muted);text-align:left}.sidebar button[aria-selected=true]{background:#6366F11C;color:#D0D1FF;border-color:#6366F14D}.sidebar .note{margin-top:auto;padding:24px 10px 0;font-size:14px}.content{padding:32px;min-width:0}.intro{margin-bottom:28px}.intro p{max-width:680px}.hero{padding:48px 0 32px}.hero h1{font-size:clamp(36px,6vw,68px);max-width:880px;line-height:1.06}.hero p{font-size:18px;max-width:640px;color:var(--muted)}.wrap{max-width:1120px;margin:auto;padding:24px}.section{padding:40px 0}.feature-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}.capability{display:flex;flex-direction:column;align-items:flex-start;gap:8px}.capability p{color:var(--muted);margin-bottom:8px}.capability .badge{margin-top:auto}.banner{padding:12px 16px;border:1px solid #F59E0B77;background:#F59E0B14;color:#FCD38A;border-radius:10px;overflow-wrap:anywhere}.card{border:1px solid #F59E0B88;border-radius:16px;padding:24px;margin:16px 0;background:var(--surface)}.card h3{white-space:pre-wrap;overflow-wrap:anywhere}.card .actions button{flex:1}.card .actions button:first-child{background:var(--gradient)}dl{display:grid;grid-template-columns:minmax(110px,auto) minmax(0,1fr);gap:10px 20px}dt{color:var(--muted)}dd{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}code,pre,.diagnostics dd{font-family:'JetBrains Mono',ui-monospace,monospace}.mark{display:inline-block;margin-left:8px;padding:2px 6px;font-size:14px;border-radius:4px;background:#F59E0B22;color:#FCD38A}.mark.remote,.mark.full-control,.mark.outside-workspace{background:#EF444422;color:#FCA5A5}.diagnostics{margin-top:28px;border-top:1px solid var(--border);padding-top:20px}.diagnostics summary{cursor:pointer;color:var(--muted);padding:12px 0}.client{padding:16px 0;border-top:1px solid var(--border)}.preset{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:12px}.preset button[aria-pressed=true]{border-color:#A5A7FF;background:#6366F124}.preset p{flex:1;min-width:180px;margin:10px 0}.empty{padding:28px;border:1px dashed #42485F;border-radius:14px;color:var(--muted)}dialog{background:var(--surface);color:var(--text);border:1px solid #6366F166;border-radius:20px;padding:32px;max-width:520px;width:calc(100% - 32px)}dialog::backdrop{background:#000B}dialog h2{font-size:28px}#notice{padding:12px 16px;background:#6366F11C;border-radius:10px}#notice:empty{display:none}[hidden]{display:none!important}footer{border-top:1px solid var(--border);padding:24px 0;color:var(--muted);font-size:14px}ul{padding-left:20px}li{margin:12px 0;overflow-wrap:anywhere}.plans{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px}.plans .panel{display:flex;flex-direction:column}.plans .panel button{margin-top:auto}.plan-featured{border-color:#7779ED}.plans .panel h3{font-size:24px}#devices{list-style:none;padding:0}#devices>li{padding:20px;border:1px solid var(--border);background:var(--raised);border-radius:12px}
@media(max-width:1050px){.plans{grid-template-columns:repeat(2,minmax(0,1fr))}.feature-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.shell{grid-template-columns:190px minmax(0,1fr)}.content{padding:24px}}
@media(max-width:700px){.shell{display:block}.sidebar{flex-direction:row;overflow-x:auto;padding:12px;border-right:0;border-bottom:1px solid var(--border)}.sidebar button{flex-shrink:0}.sidebar .note{display:none}.content,.wrap{padding:20px}.topbar{padding:16px 20px}.grid,.plans,.feature-grid{grid-template-columns:1fr}.panel,.module,.capability{padding:20px}.hero{padding-top:24px}dl{grid-template-columns:1fr;gap:4px}dd{margin-bottom:12px}.actions>*{flex-grow:1}}
@media(prefers-reduced-motion:reduce){*,*:before,*:after{animation:none!important;transition:none!important;scroll-behavior:auto!important}}
`;

export const CAPABILITIES = [
  {
    title: "Files & projects",
    description: "Read, create and organize your workspace with explicit permission boundaries.",
    status: "Available",
    icon: "files",
  },
  {
    title: "Protected terminal",
    description: "Shell commands and process management inside platform-qualified L1 confinement.",
    status: "Available · L1 required",
    icon: "terminal",
  },
  {
    title: "Smart Browser 2.0",
    description: "Tabs, forms, uploads, downloads and screenshots through controlled CDP automation.",
    status: "Available",
    icon: "browser",
  },
  {
    title: "Git & Docker",
    description: "Safe Git operations and mediated container workflows, using the same permission engine.",
    status: "Available",
    icon: "container",
  },
  {
    title: "FFmpeg & video rendering",
    description: "Planned Studio Hub workflows for rendering and media processing.",
    status: "Roadmap · not available",
    icon: "video",
  },
  {
    title: "ElevenLabs voice",
    description: "Planned AI narration and audio production integrations.",
    status: "Roadmap · not available",
    icon: "audio",
  },
  {
    title: "Publish & create",
    description: "Planned YouTube, TikTok and Canva publishing workflows.",
    status: "Roadmap · not available",
    icon: "publish",
  },
  {
    title: "Video editor handoff",
    description: "Planned Kdenlive, Shotcut and OpenTimelineIO project interchange.",
    status: "Roadmap · not available",
    icon: "video",
  },
] as const;
