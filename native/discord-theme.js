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
.cv{color:var(--text-default,var(--text-normal,#dbdee1))}
.cv :is(button,input,select,textarea,summary):focus-visible{outline:2px solid var(--focus-primary,var(--brand-500,#5865f2));outline-offset:2px}
.cv [hidden]{display:none!important}
.cv :is(input,select,textarea){min-width:0}
.cv p{overflow-wrap:anywhere}
.cv-channel-list .cv-channel-name,.cv-category-toggle{letter-spacing:normal;line-height:20px}
.cv-channel-row:not(:has(.cv-channel-delete:not(:disabled))) .cv-channel{padding-right:8px!important}
.cv-participants .cv-participant-target{border-radius:4px}
.cv-participants .cv-participant{min-width:0}
.cv button.cv-live{font-size:11px;line-height:16px;padding:0 4px;min-width:28px}
.cv-preview-heading>strong{min-width:0;font-weight:600;line-height:20px}
.cv-preview-heading>button{flex-shrink:0;width:28px;height:28px}
.cv-broadcast-hover .cv-watch-button{min-height:36px;line-height:20px}
.cv .cv-primary{background:var(--brand-500,#5865f2);color:#fff;font-weight:500}
.cv .cv-primary:hover{background:var(--brand-560,#4752c4)}
.cv-settings{padding:0 20px;max-width:760px;max-height:none;overflow:visible;font-size:14px;line-height:20px}
.cv-settings-heading{display:flex;align-items:baseline;gap:12px;padding:20px 0 4px}
.cv-settings-heading h2{margin:0;font:600 20px/28px var(--font-display,var(--font-primary,"gg sans",sans-serif));color:var(--header-primary,#f2f3f5)}
.cv-settings-heading>span{font-size:12px;line-height:18px;color:var(--text-muted,#949ba4);font-variant-numeric:tabular-nums}
.cv-settings-section{padding:20px 0;border-bottom:1px solid var(--border-subtle,var(--background-modifier-accent,#ffffff14));min-width:0}
.cv-settings-section h3,.cv-native-update h3{font-size:16px;font-weight:600;line-height:24px;color:var(--header-primary,#f2f3f5);margin:0 0 8px}
.cv-settings p{font-size:13px;line-height:20px;color:var(--text-secondary,var(--text-muted,#949ba4));margin:8px 0 12px;max-width:72ch}
.cv-settings p:empty{display:none}
.cv-settings .cv-setting{display:grid;grid-template-columns:minmax(0,1fr);align-items:center;gap:8px;margin:16px 0;font-size:14px;line-height:20px}
.cv-settings .cv-setting>span{min-width:0;overflow-wrap:anywhere;font-weight:500}
.cv-settings .cv-setting-toggle{grid-template-columns:minmax(0,1fr) 40px;gap:16px;min-height:36px}
.cv-settings .cv-setting-slider{grid-template-columns:minmax(0,1fr) auto}
.cv-settings .cv-setting-slider>input{grid-row:2;grid-column:1/-1;width:100%;margin:0}
.cv-settings .cv-setting-slider>output{grid-column:2;grid-row:1;color:var(--text-muted,#949ba4);font-size:13px;font-variant-numeric:tabular-nums}
.cv-settings :is(input:not([type=checkbox]):not([type=range]),select){width:100%;min-height:40px;padding:8px 12px;border-radius:4px;font-size:14px;line-height:20px}
.cv-settings select{color-scheme:inherit}
.cv-settings button{min-height:36px;padding:8px 12px;font-size:14px;line-height:20px;margin:4px 8px 4px 0}
.cv-settings input[type=checkbox]{width:20px;height:20px}
.cv-settings .cv-setting-toggle>input{appearance:none;-webkit-appearance:none;position:relative;width:40px;height:24px;margin:0;border:0;border-radius:12px;background:var(--background-accent,#72767d);cursor:pointer;transition:background-color 120ms}
.cv-settings .cv-setting-toggle>input::before{content:"";position:absolute;top:4px;left:4px;width:16px;height:16px;border-radius:50%;background:#fff;transition:transform 120ms}
.cv-settings .cv-setting-toggle>input:checked{background:var(--status-positive,#23a55a)}
.cv-settings .cv-setting-toggle>input:checked::before{transform:translateX(16px)}
.cv-settings .cv-setting-toggle>input:disabled{cursor:not-allowed}
.cv-settings-actions{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}
.cv-settings-actions>button{margin:0}
.cv-settings-advanced{margin:12px 0;padding:12px 0;border-block:1px solid var(--border-subtle,var(--background-modifier-accent,#ffffff14))}
.cv-settings-advanced>summary{cursor:pointer;color:var(--text-secondary,var(--text-muted,#949ba4));font-weight:500;line-height:24px}
.cv-settings-save{position:sticky;bottom:0;display:flex;align-items:center;gap:16px;padding:12px 0;margin-top:8px;background:var(--background-primary,#313338);border-top:1px solid var(--border-subtle,var(--background-modifier-accent,#ffffff14));z-index:2}
.cv-settings-feedback{flex:1;min-width:0}
.cv-settings .cv-settings-save p{margin:0;font-size:13px;line-height:20px;max-width:none}
.cv-settings .cv-settings-status{color:var(--status-positive,#23a55a)}
.cv-settings .cv-error{color:var(--text-danger,#fa777c);padding:0}
.cv-settings-save>button{flex-shrink:0;margin:0;min-width:100px}
.cv-settings-dialog{background:var(--background-primary,#313338);color-scheme:inherit}
.cv-settings-dialog>header{padding:16px 20px;min-height:56px}
.cv-settings-dialog>header button{display:grid;place-items:center;min-width:32px;min-height:32px}
.cv-settings-dialog .cv-settings{max-height:calc(100dvh - 112px);overflow:auto;scrollbar-width:thin;overscroll-behavior:contain}
.cv-native-update{margin-top:16px}
.cv-native-update h3{font-size:14px;line-height:20px}
.cv-native-update [role=status]{overflow-wrap:anywhere}
.cv-quality-dialog{font-size:14px;line-height:20px}
.cv-quality-dialog label{gap:12px;min-width:0}
.cv-quality-dialog select{min-height:36px;max-width:65%;font:inherit}
.cv-stream-heading-actions{flex-wrap:wrap;justify-content:flex-end;max-width:70%;gap:6px}
.cv-stream-resolution{line-height:18px}
.cv-viewers-list{line-height:20px}
.cv-viewers-list li{min-height:32px}
.cv-screen-toolbar button{min-height:32px;padding:6px 10px}
.cv-user-profile .cv-user-mute{gap:12px;line-height:20px}
.cv-user-profile .cv-user-mute input{flex:none}
@media(max-width:480px){.cv-settings{padding:0 12px}.cv-settings-dialog>header{padding:12px}.cv-settings-save{gap:8px}.cv-settings-save>button{min-width:84px}.cv-stream-heading-actions{max-width:75%;gap:4px}.cv-viewers summary{padding:4px 6px}}
@media(prefers-reduced-motion:reduce){.cv *{scroll-behavior:auto;transition:none!important;animation:none!important}}
@media(forced-colors:active){.cv-settings .cv-setting-toggle>input{appearance:auto;-webkit-appearance:checkbox}.cv-settings .cv-setting-toggle>input::before{display:none}}
`;
