(() => {
  const messages=window.STUDIO_MESSAGES||{};
  window.StudioI18n={ui:(message,...args)=>(messages[message]??message).replace(/\{(\d+)\}/g,(_match,i)=>String(args[Number(i)]??''))};
})();
