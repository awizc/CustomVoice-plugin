// Use Discord theme tokens; size nickname rows independently of optional badges.
var customVoiceDiscordCss = `
.cv{font-family:var(--cv-font-family,var(--font-primary,"gg sans","Noto Sans",sans-serif));font-size:14px;line-height:1.42857143;font-weight:400;letter-spacing:normal;text-align:left;color:var(--text-normal,#dbdee1)}
.cv button,.cv input,.cv select,.cv textarea{font-family:inherit;letter-spacing:inherit;line-height:inherit}
.cv button{font-weight:500;box-sizing:border-box}
.cv button,.cv summary{user-select:none;-webkit-user-select:none}
.cv h2,.cv h3,.cv strong{font-family:inherit;letter-spacing:normal}
.cv .cv-icon{display:block;flex-shrink:0}
.cv-avatar{font-family:inherit;font-weight:500;line-height:1;overflow:hidden}
.cv-avatar img{display:block;object-fit:cover}
.cv-participants{padding:0 8px 0 32px}
.cv-participants .cv-participant{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;min-height:var(--cv-participant-height,32px);padding:0 4px 0 0;column-gap:4px;font-size:var(--cv-participant-font-size,14px);font-weight:500;line-height:20px}
.cv-participants .cv-participant-target{display:grid;grid-template-columns:24px minmax(0,1fr) auto;align-items:center;gap:8px;width:100%;min-width:0;min-height:var(--cv-participant-height,32px);padding:4px 8px;border:0;margin:0;font:inherit;text-align:left;background:transparent;box-shadow:none}
.cv-participants .cv-user-name{display:block;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;line-height:20px;unicode-bidi:plaintext}
.cv-participants .cv-badges{display:flex;align-items:center;justify-content:flex-end;gap:4px;margin:0;min-width:0;line-height:1}
.cv-participants .cv-badges:empty{display:none}
.cv-participants .cv-badges>span{display:flex;align-items:center;justify-content:center;width:16px;height:20px}
.cv-participants .cv-avatar{width:24px;height:24px;margin:0}
.cv-participant>.cv-live{align-self:center;white-space:nowrap}
.cv-card .cv-user-name{line-height:20px;unicode-bidi:plaintext}
.cv-card .cv-badges{display:flex;align-items:center;gap:4px;line-height:1}
.cv-channel-list .cv-category{letter-spacing:normal;text-transform:none}
.cv .cv-user-profile h3{line-height:1.2;word-break:break-word}
.cv .cv-quality-dialog,.cv .cv-settings-dialog{font-family:inherit;line-height:1.5}
.cv-quality-dialog{max-height:calc(100vh - 32px);overflow:auto}
.cv-quality-dialog h3{font-size:16px;line-height:24px;font-weight:600;margin:0 0 16px}
.cv-quality-dialog .cv-hint{margin:8px 0}
.cv-settings label{line-height:20px}
.cv-settings select{color-scheme:inherit}
.cv-screen-toolbar button{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:28px;line-height:18px}
.cv-stream-heading-actions{min-width:0;line-height:20px}
.cv-stream-resolution{font-variant-numeric:tabular-nums;white-space:nowrap}
.cv-viewers{position:relative;flex:none;max-width:100%;font-size:12px;line-height:18px;color:var(--text-normal,#dbdee1)}
.cv-viewers summary{display:flex;align-items:center;gap:4px;padding:4px 8px;border-radius:4px;cursor:pointer;list-style:none;white-space:nowrap;background:var(--background-modifier-hover,#35373c);font-weight:500}
.cv-viewers summary::after{content:"▾";font-size:10px}
.cv-viewers[open] summary::after{content:"▴"}
.cv-viewers summary:focus-visible{outline:2px solid var(--brand-500,#5865f2);outline-offset:2px}
.cv-viewers-list{position:absolute;right:0;top:calc(100% + 6px);width:250px;max-width:calc(100vw - 32px);padding:12px;background:var(--background-floating,#111214);border:1px solid var(--border-subtle,#ffffff14);border-radius:8px;box-shadow:var(--elevation-high,0 8px 24px #0006);z-index:5;text-align:left}
.cv-viewers-list strong{display:block;font-size:14px;line-height:20px}
.cv-viewers-list ul{list-style:none;margin:8px 0;padding:0;max-height:200px;overflow:auto}
.cv-viewers-list li{display:grid;grid-template-columns:24px minmax(0,1fr);align-items:center;gap:8px;padding:4px 0;font-size:14px;line-height:20px}
.cv-viewers-list li>span:last-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cv-viewers-list p{margin:8px 0 0;line-height:18px}
.cv-screen:has(.cv-viewers[open])>.cv-screen-heading{opacity:1!important;visibility:visible!important;pointer-events:auto}
.cv .cv-audio-state{font-size:12px;line-height:18px;color:var(--text-muted,#949ba4)}
@media(prefers-reduced-motion:reduce){.cv *{scroll-behavior:auto}}
`;
