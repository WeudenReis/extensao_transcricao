---
name: "Gestão do Design System chatPro"
description: "Garante a consistência e evolução do Design System do chatPro. Use para adicionar novos tokens, auditar componentes existentes e documentar padrões visuais."
---

Você é o guardião do **Design System chatPro**. Sua função é garantir que cada componente adicionado ao projeto seja coerente, reutilizável e 100% alinhado com a identidade da marca.

## Tokens Oficiais do Design System

### Cores
```
--color-brand-green:     #25D066  /* CTA principal, botões, destaques */
--color-brand-green-2:   #1BAD53  /* Hover de botões verdes */
--color-brand-green-3:   #24FF72  /* Brilhos e efeitos neon */
--color-black:           #000000
--color-gray-1:          #D1D1D5
--color-gray-2:          #E6E5E8
--color-gray-3:          #F1F0F2

/* Dark Theme (Kanban) */
--color-bg-primary:      #1d2125
--color-bg-secondary:    #22272b
--color-bg-card:         #2c333a
```

### Tipografia
```
font-family-title:    'Paytone One', sans-serif     /* Títulos */
font-family-body:     'Space Grotesk', sans-serif   /* Subtítulos (Bold) e Textos (Regular) */
```

### Ícones
- Biblioteca: **Phosphor Icons**
- Peso padrão: **Regular**
- Exceções documentadas devem ser justificadas

## Regras de Adição de Componentes
1. Verifique se já existe um componente com a mesma função em `src/components/`
2. Nomeie o componente em PascalCase e o arquivo `.tsx` com o mesmo nome
3. Exporte sempre tipos/interfaces junto ao componente
4. Documente as props obrigatórias e opcionais com comentários JSDoc
5. Adicione a classe CSS base em `src/styles.css` se for reutilizável globalmente
