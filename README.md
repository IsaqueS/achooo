# Achooo!

Coloque todas as fotos de um imóvel e elas saem **endireitadas e tratadas** automaticamente:

- **Endireitar** — detecta as linhas verticais (portas, paredes, janelas) e gira a foto até ficarem retas.
- **Corrigir perspectiva** — tira o efeito de "parede caindo" quando o celular estava inclinado para cima ou para baixo.
- **Cor e luz** — tira o amarelado, ajusta o branco, clareia ambientes escuros e realça as cores.
- **Nitidez** — realce leve de detalhes.

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
5. Cor: balanço de branco pelos tons neutros claros (esfriar o amarelado é aplicado com força, esquentar só de leve), níveis, brilho dos meios-tons, contraste suave e vibração.

Fonte: [Chakra Petch](https://fonts.google.com/specimen/Chakra+Petch) (SIL Open Font License).
