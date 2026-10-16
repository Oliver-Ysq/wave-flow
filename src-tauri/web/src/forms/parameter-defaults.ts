/** 显式准备表单的初始建议值，不在校验器内隐式修改输入；已有值（含空串/null）优先。 */
export function suggestedParameters(schema:Record<string,unknown>,input:Record<string,unknown>):Record<string,unknown>{
  const output={...input};
  const properties=(schema.properties??{}) as Record<string,Record<string,unknown>>;
  for(const [key,node] of Object.entries(properties)){
    if(!Object.prototype.hasOwnProperty.call(output,key)&&"default" in node)output[key]=structuredClone(node.default);
  }
  return output;
}
