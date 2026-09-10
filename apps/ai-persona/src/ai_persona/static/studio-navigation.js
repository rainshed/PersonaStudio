(() => {
  const group=document.querySelector('.persona-nav'), narrow=matchMedia('(max-width:760px)');
  if(!group)return;
  const adapt=()=>{group.open=!narrow.matches;};
  adapt();narrow.addEventListener('change',adapt);
  group.addEventListener('toggle',()=>{if(!narrow.matches&&!group.open)group.open=true;});
  document.addEventListener('keydown',event=>{if(event.key==='Escape'&&narrow.matches&&group.open){group.open=false;group.querySelector('summary').focus();}});
  document.addEventListener('click',event=>{if(narrow.matches&&!group.contains(event.target))group.open=false;});
})();
