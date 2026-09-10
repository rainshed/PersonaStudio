export const ui=(message,...args)=>globalThis.StudioI18n?.ui(message,...args)??message.replace(/\{(\d+)\}/g,(_match,i)=>String(args[Number(i)]??''));
