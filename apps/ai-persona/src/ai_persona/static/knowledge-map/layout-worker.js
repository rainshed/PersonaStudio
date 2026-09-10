importScripts('./vendor/elk-api.js','./layout-core.js');
const elk=new ELK({workerUrl:'./vendor/elk-worker.min.js'});
let chain=Promise.resolve();
self.onmessage=({data})=>{chain=chain.then(async()=>{try{const layout=await GraphLayout.layout(data.graph,data.mode,elk);self.postMessage({id:data.id,layout});}catch(error){self.postMessage({id:data.id,error:error.message});}});};
