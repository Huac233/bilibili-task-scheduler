<script setup lang="ts">
import { useThemeVars } from 'naive-ui'

/**
 * The application footer.
 *
 * Four lines, reproduced exactly as YG wrote them — two traditional-Chinese
 * lines, his signature, then the repository link. The text is his, verbatim, and
 * nothing here paraphrases, converts or corrects it; the repository name is the
 * whole of the link, with no call to action beside it.
 *
 * It is a footer, so it stays quiet: colours come from the live Naive UI theme
 * rather than from literals, and it is right-aligned at 13px/1.7 — a step down
 * from the body size (14px), with tighter leading than it carried before. Quiet
 * is not invisible, though: the quote keeps the readable theme colour, because
 * someone may actually want to read it.
 *
 * Where it sits is the shell's business, not this file's. AppShell makes each
 * layout's scroll container a flex column and grows the content above it, which
 * is what puts the footer at the bottom of a short page. Nothing here pins,
 * floats or reserves height — this stays a plain block at the end of the flow,
 * so it can never cover a control or squeeze a view on a short screen.
 */
const themeVars = useThemeVars()
</script>

<template>
  <footer
    class="app-footer"
    :style="{ color: themeVars.textColor2, borderTopColor: themeVars.borderColor }"
  >
    <p class="quote">不知不覺間，我開始滿心期待這朵花蕾在春天綻放。</p>
    <p class="quote">因為我從未想過，它盛開的模樣竟會那般醜陋。</p>
    <p class="signature">——少年的深淵</p>
    <p class="repo">
      <a
        class="repo-link"
        :style="{ color: themeVars.primaryColor }"
        href="https://github.com/Huac233/bilibili-task-scheduler"
        target="_blank"
        rel="noopener noreferrer"
        >bilibili-task-scheduler</a>
    </p>
  </footer>
</template>

<style scoped>
.app-footer {
  margin-top: 24px;
  padding-top: 16px;
  border-top: 1px solid;
  font-size: 13px;
  line-height: 1.7;
  /* Right-aligned on purpose — not a missing `text-align` to be centred later. */
  text-align: right;
}

.quote {
  margin: 0;
}

.signature {
  margin: 2px 0 0;
}

.repo {
  margin: 14px 0 0;
}

.repo-link {
  text-decoration: underline;
}
</style>
