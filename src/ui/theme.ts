/** First-party, offline design tokens shared by Control Center and the hosted portal. */
export const CROT_CSS = `
:root{color-scheme:dark;--bg-app:#09090B;--bg-card:#121215;--bg-elevated:#18181B;--border-subtle:#27272A;--text-primary:#FAFAFA;--text-secondary:#A1A1AA;--text-muted:#71717A;--accent-primary:#6366F1;--status-ok:#10B981;--status-warn:#F59E0B;--status-err:#EF4444;--bg:var(--bg-app);--surface:var(--bg-card);--raised:var(--bg-elevated);--border:var(--border-subtle);--text:var(--text-primary);--muted:var(--text-secondary);--accent:#A5A7FF;--gradient:var(--accent-primary);--ready:var(--status-ok);--warning:var(--status-warn);--error:var(--status-err);font:13px/1.5 -apple-system,BlinkMacSystemFont,"Inter","Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--text)}
*,*:before,*:after{box-sizing:border-box;-webkit-font-smoothing:antialiased}body{margin:0}button,a,input,select{font:inherit}button,.button{height:32px;padding:0 12px;border:1px solid var(--border);border-radius:6px;background:var(--raised);color:var(--text);cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;justify-content:center;gap:6px;font-size:12px;font-weight:500;white-space:nowrap;transition:background .15s ease,border-color .15s ease}button:hover,.button:hover{background:#27272A}button:disabled{opacity:.55;cursor:not-allowed}button:focus-visible,a:focus-visible,summary:focus-visible,select:focus-visible{outline:2px solid var(--accent-primary);outline-offset:3px}button.primary,.button.primary{height:36px;padding:0 16px;font-size:13px;border-radius:8px;background:var(--accent-primary);border:1px solid rgba(255,255,255,.1);color:#fff}button.primary:hover,.button.primary:hover{background:#4F46E5}button.danger{color:#FCA5A5}.muted,.note{color:var(--muted)}p{margin:8px 0 12px}h1,h2,h3{line-height:1.5;letter-spacing:-.01em;margin:0 0 8px;font-weight:600}h1{font-size:16px}h2,h3{font-size:14px;color:var(--text)}a{color:var(--accent)}.eyebrow{font-size:11px;font-weight:500;letter-spacing:.03em;color:var(--text-muted)}.badge{display:inline-flex;align-items:center;gap:6px;min-height:24px;border:1px solid var(--border);padding:2px 8px;border-radius:6px;font-size:11px;font-weight:500;letter-spacing:.03em;white-space:normal}.badge.ready:before,.badge.warning:before{content:'';width:6px;height:6px;flex-shrink:0;border-radius:50%;background:var(--ready)}.badge.warning:before{background:var(--warning)}.badge.warning{color:#FCD38A}.grid,.feature-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.panel,.module,.capability,.card{border:1px solid var(--border);border-radius:10px;background:var(--surface);padding:16px;min-width:0}.panel{margin-bottom:12px}.module{display:flex;flex-direction:column;gap:8px}.module svg,.capability svg{width:20px;height:20px;color:var(--accent);margin-bottom:4px}.actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}.brand{display:flex;align-items:center;gap:8px;font-size:14px;font-weight:600;letter-spacing:.03em}.brand-mark{display:grid;place-items:center;flex-shrink:0;width:28px;height:28px;border-radius:8px;background:var(--accent-primary);color:#fff}.topbar{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:16px;border-bottom:1px solid var(--border);background:var(--surface)}.topbar .actions{margin:0}.shell{max-width:1400px;margin:auto;display:grid;grid-template-columns:200px minmax(0,1fr);min-height:calc(100vh - 68px)}.sidebar{border-right:1px solid var(--border);padding:16px;display:flex;flex-direction:column;gap:8px}.sidebar button{justify-content:flex-start;background:transparent;color:var(--muted);text-align:left}.sidebar button[aria-selected=true]{background:var(--raised);color:var(--text);border-color:#6366F1}.sidebar .note{margin-top:auto;font-size:11px}.content{padding:16px;min-width:0}.intro{margin-bottom:16px}.intro p{max-width:680px}.hero{padding:32px 0}.hero h1{font-size:32px;font-weight:700;max-width:880px;line-height:1.2}.hero p{font-size:13px;max-width:640px;color:var(--muted)}.wrap{max-width:1120px;margin:auto;padding:16px}.section{padding:24px 0}.feature-grid{grid-template-columns:repeat(3,minmax(0,1fr))}.capability{display:flex;flex-direction:column;align-items:flex-start;gap:8px}.capability p{color:var(--muted);margin-bottom:8px}.capability .badge{margin-top:auto}.banner{padding:12px 16px;border:1px solid var(--border);background:#F59E0B14;color:#FCD38A;border-radius:6px;overflow-wrap:anywhere}.card{margin:12px 0}.card h3{white-space:pre-wrap;overflow-wrap:anywhere}.card .actions button{flex:1}.card .actions button:first-child{background:var(--accent-primary)}dl{display:grid;grid-template-columns:minmax(100px,auto) minmax(0,1fr);gap:8px 12px}dt{color:var(--muted)}dd{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}code,pre,.diagnostics dd{font:12px/1.5 'JetBrains Mono',ui-monospace,monospace;background:var(--raised);border:1px solid var(--border);padding:6px 10px;border-radius:6px;overflow-wrap:anywhere;white-space:pre-wrap}.mark{display:inline-block;margin-left:8px;padding:2px 6px;font-size:11px;border-radius:4px;background:#F59E0B22;color:#FCD38A}.mark.remote,.mark.full-control,.mark.outside-workspace{background:#EF444422;color:#FCA5A5}.diagnostics{margin-top:16px;border-top:1px solid var(--border);padding-top:12px}.diagnostics summary{cursor:pointer;color:var(--muted);padding:8px 0}.client{padding:12px 0;border-top:1px solid var(--border)}.preset{display:flex;align-items:flex-start;gap:12px;flex-wrap:wrap;margin-bottom:12px}.preset button[aria-pressed=true]{border-color:var(--accent-primary);background:var(--raised)}.preset p{flex:1;min-width:180px;margin:6px 0}.empty{padding:16px;border:1px dashed var(--border);border-radius:10px;color:var(--muted)}dialog{background:var(--surface);color:var(--text);border:1px solid var(--border);border-radius:10px;padding:16px;max-width:480px;width:calc(100% - 32px)}dialog::backdrop{background:#000B}dialog h2{font-size:16px}#notice{padding:8px 12px;background:var(--raised);border-radius:6px}#notice:empty{display:none}[hidden]{display:none!important}footer{border-top:1px solid var(--border);padding:16px 0;color:var(--muted);font-size:11px}ul{padding-left:20px}li{margin:12px 0;overflow-wrap:anywhere}.plans{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}.plans .panel{display:flex;flex-direction:column}.plans .panel button{margin-top:auto}.plan-featured{border-color:var(--accent-primary)}#devices{list-style:none;padding:0}#devices>li{padding:16px;border:1px solid var(--border);background:var(--raised);border-radius:10px}.language{height:32px;border:1px solid var(--border);border-radius:6px;background:var(--raised);color:var(--text);padding:0 8px;font-size:11px}.quick-start{margin-bottom:12px}.quick-start code{display:block;margin:8px 0}.quick-start .actions{align-items:center}
@media(max-width:1050px){.plans{grid-template-columns:repeat(2,minmax(0,1fr))}.feature-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:700px){.shell{display:block}.sidebar{flex-direction:row;overflow-x:auto;padding:12px 16px;border-right:0;border-bottom:1px solid var(--border)}.sidebar button{flex-shrink:0}.sidebar .note{display:none}.grid,.plans,.feature-grid{grid-template-columns:1fr}dl{grid-template-columns:1fr;gap:4px}dd{margin-bottom:8px}.actions{align-items:flex-start}.actions>*{max-width:100%}.preset{flex-direction:column}.preset p{min-width:0}.brand .muted{display:none}}
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
