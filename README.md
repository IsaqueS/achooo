# Achooo!

Coloque todas as fotos de um imóvel e elas saem **endireitadas e tratadas** automaticamente:

- **Endireitar** — detecta as linhas verticais (portas, paredes, janelas) e gira a foto até ficarem retas.
- **Corrigir perspectiva** — tira o efeito de "parede caindo" quando o celular estava inclinado para cima ou para baixo.
- **Cor e luz** — estilo de foto de imobiliária: paredes claras e limpas, brancos sem estourar, cores fortes mais vivas e mais contraste local.
- **Nitidez** — realce de detalhes que ignora o ruído fino.
- **Remover marca d'água** — quando você envia 3 ou mais fotos com a mesma marca repetida, o app estima automaticamente a transparência e a cor da marca e reconstrói a imagem por baixo antes de endireitar e ajustar as cores.

Tudo roda no navegador: nenhuma foto é enviada para servidor nenhum.
Dá para baixar uma por uma ou todas num `.zip`.

## Publicar no GitHub Pages

1. Crie um repositório no GitHub e envie estes arquivos (o `.gitignore` já deixa de fora as pastas `Fotos de exemplo/` e `Inspiração/`).
2. No repositório: **Settings → Pages → Build and deployment → Source: Deploy from a branch**, escolha a branch `main` e a pasta `/ (root)`.
3. Em um minuto o site fica em `https://SEU-USUARIO.github.io/NOME-DO-REPOSITORIO/`.

## Rodar no computador

O navegador não deixa usar *workers* abrindo o `index.html` direto do disco em alguns casos (o app ainda funciona, só fica mais lento). Para testar como no GitHub Pages:

```bash
python3 -m http.server 8000
# abra http://localhost:8000
```

## Estrutura

```
index.html          página
css/style.css       visual
fonts/              Chakra Petch Bold
js/watermark.js     detecção e remoção automática de marca d'água em lote
js/core.js          processamento (detecção de linhas, ponto de fuga, correção, cor)
js/pipeline.js      abre a foto, chama o core, gera o JPG
js/worker.js        roda o processamento fora da tela principal
js/zip.js           gera o .zip (sem dependências)
js/app.js           interface
```

## Como funciona (resumo técnico)

1. A foto é reduzida (~900 px) e passa por uma detecção de segmentos de reta (versão simplificada do LSD).
2. Com os segmentos quase verticais, um RANSAC encontra o **ponto de fuga vertical**.
3. Desse ponto saem a inclinação lateral (*roll*) e a inclinação para cima/baixo (*pitch*). A foto é "re-fotografada" por uma câmera virtual girada (`H = K·R·K⁻¹`), e o maior retângulo com a mesma proporção é recortado.
4. Travas de segurança: se a câmera estava apontada muito para o chão/teto ou a detecção é fraca, o ângulo é mantido; se o recorte ficaria grande demais, a correção é suavizada.
5. Cor: balanço de branco pelos tons neutros claros (esfriar o amarelado é aplicado com força, esquentar só de leve) e um branco levemente quente. A curva tonal foi ajustada em pares antes/depois de referência: a luminância do percentil 80 (a "parede") vai para ~217/255, com ombro suave (Reinhard estendido) e um "S" de contraste, aplicada na luminância para não mudar o matiz. Depois vêm contraste local (raio ~1% do lado maior, contido em bordas fortes), saturação só nas cores fortes (amarelo com menos força) e tons claros pouco saturados puxados para o branco.

Fonte: [Chakra Petch](https://fonts.google.com/specimen/Chakra+Petch) (SIL Open Font License).
