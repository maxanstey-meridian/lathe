import { mount } from "@vue/test-utils";
import type { TailPaneState } from "@lathe/tail-state";
import { describe, expect, test } from "vitest";
import { nextTick } from "vue";

import TailPane from "../app/pages/index/components/TailPane.vue";

const mountPane = (pane: TailPaneState, activity?: readonly string[]) =>
  mount(TailPane, {
    props: {
      title: "daddy",
      model: "gpt-5.4-mini",
      pane,
      accent: "magenta",
      now: 1_000,
      activity,
    },
    global: {
      components: {
        UButton: { template: '<button v-bind="$attrs"><slot /></button>' },
        UModal: {
          props: { open: Boolean, title: String, persist: Boolean },
          template: '<div v-if="open" class="modal"><slot name="body" /><slot name="footer" /></div>',
        },
      },
    },
  });

describe("TailPane JSON buttonification", () => {
  test("buttonifies pretty-printed JSON streamed across pane lines", () => {
    const wrapper = mountPane({
      current: "",
      currentStyle: "text",
      lastAt: 1_000,
      lines: [
        { text: "Here is the decision:", style: "text" },
        { text: "{", style: "text" },
        { text: '  "status": "proceed_with_constraints",', style: "text" },
        { text: '  "answer": "Proceed.",', style: "text" },
        { text: '  "constraints": ["keep tests focused"],', style: "text" },
        { text: '  "evidence_used": ["journal", "diff"],', style: "text" },
        { text: '  "safe_next_action": "submit report",', style: "text" },
        { text: '  "human_decision_needed": null', style: "text" },
        { text: "}", style: "text" },
      ],
    });

    expect(wrapper.text()).toContain("Here is the decision:");
    expect(wrapper.text()).toContain("{6 keys}");
    expect(wrapper.text()).not.toContain("[args]");
    wrapper.unmount();
  });

  test("waits for the outer object instead of buttonifying nested arrays", () => {
    const wrapper = mountPane({
      current: "",
      currentStyle: "text",
      lastAt: 1_000,
      lines: [
        { text: "{", style: "text" },
        { text: '  "status": "proceed_with_constraints",', style: "text" },
        { text: `  "answer": "${"a".repeat(90)}",`, style: "text" },
        { text: `  "constraints": ["${"constraint ".repeat(10)}"],`, style: "text" },
        { text: `  "evidence_used": ["${"evidence ".repeat(12)}"],`, style: "text" },
      ],
    });

    expect(wrapper.findAll("button")).toHaveLength(0);
    expect(wrapper.text()).toContain('"constraints": ["constraint constraint');
    wrapper.unmount();
  });

  test("does not consume independent JSON after malformed prose", () => {
    const independent = JSON.stringify({ status: "ok", answer: "continue", padding: "x".repeat(80) });
    const wrapper = mountPane({
      current: "",
      currentStyle: "text",
      lastAt: 1_000,
      lines: [
        { text: "Use {name} in this malformed example", style: "text" },
        { text: "This line must remain visible", style: "text" },
        { text: independent, style: "text" },
      ],
    });

    expect(wrapper.text()).toContain("Use {name} in this malformed example");
    expect(wrapper.text()).toContain("This line must remain visible");
    expect(wrapper.text()).toContain("{3 keys}");
    expect(wrapper.findAll("button")).toHaveLength(1);
    wrapper.unmount();
  });

  test("stops grouping when an incomplete candidate becomes structurally invalid", () => {
    const independent = JSON.stringify({ status: "ok", padding: "y".repeat(80) });
    const wrapper = mountPane({
      current: "",
      currentStyle: "text",
      lastAt: 1_000,
      lines: [
        { text: "{", style: "text" },
        { text: "] malformed continuation", style: "text" },
        { text: independent, style: "text" },
      ],
    });

    expect(wrapper.text()).toContain("] malformed continuation");
    expect(wrapper.text()).toContain("{2 keys}");
    expect(wrapper.findAll("button")).toHaveLength(1);
    wrapper.unmount();
  });
});

describe("TailPane scrolling", () => {
  test("preserves a user's scroll position until they return to the tail", async () => {
    const line = (text: string) => ({ text, style: "text" as const });
    const wrapper = mountPane({
      current: "",
      currentStyle: "text",
      lastAt: 1_000,
      lines: [line("one"), line("two")],
    });
    const scroller = wrapper.get('[data-testid="tail-scroll"]');
    const element = scroller.element as HTMLElement;
    Object.defineProperties(element, {
      scrollHeight: { configurable: true, value: 1_000 },
      clientHeight: { configurable: true, value: 200 },
    });

    element.scrollTop = 300;
    await scroller.trigger("scroll");
    await wrapper.setProps({
      pane: {
        current: "",
        currentStyle: "text",
        lastAt: 1_001,
        lines: [line("one"), line("two"), line("three")],
      },
    });
    await nextTick();
    expect(element.scrollTop).toBe(300);

    element.scrollTop = 790;
    await scroller.trigger("scroll");
    await wrapper.setProps({
      pane: {
        current: "",
        currentStyle: "text",
        lastAt: 1_002,
        lines: [line("one"), line("two"), line("three"), line("four")],
      },
    });
    await nextTick();
    expect(element.scrollTop).toBe(1_000);
    wrapper.unmount();
  });
});

describe("TailPane activity", () => {
  test("shows durable command activity instead of idle state", () => {
    const wrapper = mountPane({
      current: "",
      currentStyle: "text",
      lastAt: 0,
      lines: [],
    }, ["task api:test · 4m12s"]);

    expect(wrapper.text()).toContain("running");
    expect(wrapper.text()).toContain("task api:test · 4m12s");
    expect(wrapper.text()).not.toContain("idle");
    wrapper.unmount();
  });
});
