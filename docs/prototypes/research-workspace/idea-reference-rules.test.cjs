const test=require('node:test'),assert=require('node:assert/strict');
const native=require('../../../apps/ai-persona/src/ai_persona/static/idea-reference-rules.js');
const research=require('./references.js');
test('unified Ideas and research projects recognize exactly the same Markdown references',()=>{
 const samples=['[A](kb:ps_aaaaaaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb)', '`[example](kb:fake)`\n\n![image](kb:fake)\n\\[escaped](kb:fake)', '~~~md\n[A](kb:fake)\n~~~\n[B](kb:real)', '`` [a](kb:no) `inside` ``\n\n# [C](kb:yes)', 'before [one](kb:id) and [two](kb:id)'];
 for(const body of samples){assert.deepEqual(native.citations(body),research.citations(body));assert.equal(native.stripCitations(body),research.stripCitations(body));}
 const body='[inline](kb:same) [again](kb:same)';const refs=native.related({related_refs:['same'],body});assert.equal(refs.length,1);assert.equal(refs[0].occurrences.length,2);assert.equal(refs[0].manual,true);
});
