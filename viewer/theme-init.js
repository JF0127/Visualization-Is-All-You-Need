(() => {
  try {
    const saved = localStorage.getItem("p025-theme");
    const theme =
      saved === "dark" || saved === "light"
        ? saved
        : matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light";
    document.documentElement.dataset.theme = theme;
  } catch {
    /* 隐私模式/无 localStorage 时跟随系统 */
  }
})();
