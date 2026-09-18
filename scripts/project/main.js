import { EnergyExperiment } from "./experiment.js";

// Construct's own runtime input events work with mouse, pen, touch and workers.
runOnStartup(runtime => {
	let experiment = null;
	runtime.addEventListener("beforeanylayoutstart", ({ layout }) => {
		if (layout.name === "game") experiment = new EnergyExperiment(runtime);
	});
	runtime.addEventListener("beforeanylayoutend", () => {
		experiment?.dispose();
		experiment = null;
	});
	runtime.addEventListener("tick", () => experiment?.tick(runtime.dt));
	for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel"])
		runtime.addEventListener(type, event => experiment?.input(type, event));
	// A lost window focus must not leave a spoon attached to an old pointer.
	runtime.addEventListener("suspend", () => experiment?.cancelDrag());
});
