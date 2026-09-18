// Deney süreleri ve hedefleri burada düzenlenebilir. Sıcaklıklar Senaryo.jpeg'in
// öğretim değerleridir; miktar/derişim verilmediği için ölçüm iddiası taşımaz.
export const SETTINGS = Object.freeze({
	dropMargin: 100,
	thermometerDropMargin: 50,
	blinkPeriod: 1.2,
	pourFPS: 24,
	spoonLiftFPS: 52,
	thermometerLiftFPS: 30,
	spoonReturnSeconds: 0.24,
	returnSeconds: 0.45,
	spoonSaltApproachSeconds: 0.3,
	spoonDipSeconds: 0.2,
	spoonDipDepth: 10,
	spoonBowlOffsetX: 130,
	spoonSaltTopOffsetY: -128,
	spoonLoadedOffsetY: -105,
	spoonPourApproachSeconds: 0.42,
	waterLastFrame: 189,
	thermometerApproachSeconds: 0.45,
	thermometerInsertSeconds: 0.8,
	nh4cl: { seconds: 18, temperature: 12 },
	ch3coona: { seconds: 22, temperature: 50 }
});

const WHITE = [1, 1, 1];
const COLORS = { system: [1, 0.647, 0], surroundings: [0, 0.67, 1], universe: [0.05, 1, 0] };
const BUTTONS = { system: "sistembt", surroundings: "Çevrebt", universe: "Evrenbt" };
const clamp = (n, low, high) => Math.max(low, Math.min(high, n));
const smooth = p => p * p * (3 - 2 * p);

function inRect(sprite, x, y, margin = 0) {
	const r = sprite.getBoundingBox();
	return x >= r.left - margin && x <= r.right + margin &&
		y >= r.top - margin && y <= r.bottom + margin;
}

function still(sprite, name = "Default", frame = 0) {
	sprite.setAnimation(name);
	sprite.stopAnimation();
	sprite.animationFrame = frame;
	// Source frames were cropped with preserved origins. Native scale is essential
	// when changing from a spoon into the much taller pouring animation.
	sprite.setSize(sprite.imageWidth, sprite.imageHeight);
}

export class EnergyExperiment {
	constructor(runtime) {
		this.runtime = runtime;
		this.o = {};
		for (const name of ["img", "img2", "img3", "arkabeher", "önbeherdikkat", "arkaplan",
			"karistiriciacik", "paremetre", "NH4Cl", "CH3COONa", "OFFbt", "gösterge",
			"sistembt", "Çevrebt", "Evrenbt", "Ekzotermik", "Endotermikbt"])
			this.o[name] = runtime.objects[name].getFirstInstance();
		this.spoon = this.o.img3;
		this.water = this.o.img;
		this.thermometer = this.o.img2;
		this.spoonHome = [this.spoon.x, this.spoon.y];
		this.stage = "spoon"; // spoon -> salt -> loaded -> pouring -> thermometer -> ready -> mixing -> complete
		this.salt = null;
		this.spoonReadyForBeaker = false;
		this.drag = null;
		this.returning = null;
		this.spoonMotion = null;
		this.time = 0;
		this.mixTime = 0;
		this.stirring = false;
		// The three concept buttons are available throughout the experiment.
		this.unlocked = true;
		this.selection = null;
		this.conceptHint = false;
		this.answerHint = false;
		this.answered = false;
		this.thermometerPlaced = false;
		this.thermometerPending = false;
		this.thermometerInserting = false;
		this.thermometerPhase = null;
		this.thermometerTargetHint = false;
		this.thermometerInsertTime = 0;
		this.temperature = 25;
		this.outlineCache = new Map();
		for (const instance of Object.values(this.o)) instance.stopAnimation();
		for (const name of [...Object.values(BUTTONS), "OFFbt", "karistiriciacik", "Ekzotermik", "Endotermikbt"])
			this.o[name].animationFrame = 0;
		for (const name of Object.values(BUTTONS)) this.o[name].opacity = 1;
		this.water.animationFrame = 0;
		this.onPourEnd = event => {
			if (String(event.animationName).toLowerCase() === "dokulme" && this.stage === "pouring")
				this.finishPour();
		};
		this.spoon.addEventListener("animationend", this.onPourEnd);
		this.onThermometerLiftEnd = event => {
			if (String(event.animationName).toLowerCase() === "default" && this.thermometerPending)
				this.startThermometerInsertion();
		};
		this.thermometer.addEventListener("animationend", this.onThermometerLiftEnd);
		this.tableLines = runtime.objects.MasaKontur.getAllInstances();
		this.readout = runtime.objects.Sicaklik.getFirstInstance();
		this.readout.fontFace = "Arial";
		this.readout.sizePt = 26;
		this.readout.fontColor = WHITE;
		this.readout.horizontalAlign = "center";
		this.readout.verticalAlign = "center";
		this.readout.text = "25 °C";
		this.readout.isVisible = false;
		this.o["gösterge"].isVisible = false;
		this.renderOutlines();
	}

	input(type, event) {
		if (type === "pointercancel") {
			if (this.drag?.id === event.pointerId) this.cancelDrag();
			return;
		}
		const [x, y] = this.water.layer.cssPxToLayer(event.clientX, event.clientY);
		if (type === "pointerdown") {
			if (this.drag || this.returning || this.spoonMotion || this.thermometerInserting ||
				(event.button !== undefined && event.button !== 0)) return;
			for (const [selection, name] of Object.entries(BUTTONS)) {
				if (inRect(this.o[name], x, y)) {
					this.chooseConcept(selection);
					return;
				}
			}
			if (inRect(this.o.OFFbt, x, y)) { this.toggleStirrer(); return; }
			for (const name of ["Ekzotermik", "Endotermikbt"]) {
				if (inRect(this.o[name], x, y)) { this.answer(name); return; }
			}
			if (["spoon", "salt", "loaded"].includes(this.stage) && this.spoon.containsPoint(x, y)) {
				if (this.stage === "spoon") this.stage = "salt";
				if (this.stage === "loaded") this.spoonReadyForBeaker = true;
				this.startDrag(this.spoon, "spoon", event.pointerId, x, y);
			} else if (this.stage === "thermometer" && !this.thermometerPlaced &&
				!this.thermometerPending && !this.thermometerInserting &&
				(this.thermometer.containsPoint(x, y) || inRect(this.thermometer, x, y, 24))) {
				this.thermometerTargetHint = true;
				this.startDrag(this.thermometer, "thermometer", event.pointerId, x, y);
			}
			this.renderOutlines();
			return;
		}
		if (!this.drag || this.drag.id !== event.pointerId) return;
		if (type === "pointermove" || type === "pointerup") {
			const d = this.drag;
			d.instance.setPosition(x + d.dx, y + d.dy);
			if (type === "pointerup") {
				this.drag = null;
				if (d.kind === "thermometer") {
					if (inRect(this.o.arkabeher, x, y, SETTINGS.thermometerDropMargin)) {
						this.thermometerPending = true;
						if (this.thermometer.animationFrame >= 30) this.startThermometerInsertion();
					} else this.reverseDrag(d);
				} else this.dropSpoon(x, y, d);
				this.renderOutlines();
			}
		}
	}

	startDrag(instance, kind, id, x, y) {
		this.drag = { instance, kind, id, dx: instance.x - x, dy: instance.y - y,
			startX: instance.x, startY: instance.y, animation: instance.animationName,
			frame: instance.animationFrame, width: instance.width, height: instance.height,
			startedLoaded: kind === "spoon" && this.stage === "loaded",
			startSalt: kind === "spoon" ? this.salt : null };
		this.playSound("click");
		instance.moveToTop();
		if (instance.animationName === "Default") {
			instance.animationSpeed = kind === "spoon" ? SETTINGS.spoonLiftFPS : SETTINGS.thermometerLiftFPS;
			instance.startAnimation("beginning");
		}
	}

	restoreDrag(drag) {
		still(drag.instance, drag.animation, drag.frame);
		drag.instance.setSize(drag.width, drag.height);
		drag.instance.setPosition(drag.startX, drag.startY);
		if (drag.kind === "thermometer")
			drag.instance.moveAdjacentToInstance(this.o["önbeherdikkat"], false);
	}

	reverseDrag(drag) {
		// Keep the object exactly where it was released while the lifting motion
		// runs backwards. Once it lies flat again, tween it to its resting place.
		if (drag.animation === "Default" && drag.instance.animationName === "Default" &&
			drag.instance.animationFrame > 0) {
			this.returning = { ...drag, phase: "reverse" };
			drag.instance.animationSpeed = -(drag.kind === "spoon" ? SETTINGS.spoonLiftFPS : SETTINGS.thermometerLiftFPS);
			drag.instance.startAnimation("current-frame");
			return;
		}
		this.startReturnTween(drag);
	}

	startReturnTween(drag = this.returning) {
		if (!drag) return;
		const instance = drag.instance;
		// Restore the resting artwork without changing the release position.
		still(instance, drag.animation, drag.frame);
		instance.setSize(drag.width, drag.height);
		this.returning = {
			...drag,
			phase: "tween",
			returnTime: 0,
			returnFromX: instance.x,
			returnFromY: instance.y
		};
	}

	cancelDrag() {
		if (!this.drag) return;
		this.restoreDrag(this.drag);
		this.drag = null;
	}

	dropSpoon(x, y, drag) {
		const r = this.spoon.getBoundingBox();
		const bowlX = r.left + r.width * 0.20;
		const bowlY = r.top + r.height * 0.80;
		// Check dishes first. A spoon can be re-filled from either dish until pouring.
		for (const [salt, name] of [["nh4cl", "NH4Cl"], ["ch3coona", "CH3COONa"]]) {
			const dish = this.o[name];
			if (inRect(dish, bowlX, bowlY, 18) || inRect(dish, x, y, 12)) {
				// A loaded spoon rests on its source dish. Clicking it there must not
				// look like another scoop; only moving it to the other salt re-dips it.
				if (drag.startedLoaded && salt === drag.startSalt) {
					this.restoreDrag(drag);
					return;
				}
				this.startSpoonDip(salt, dish);
				return;
			}
		}
		if (this.salt && this.spoonReadyForBeaker &&
			(inRect(this.o.arkabeher, bowlX, bowlY, SETTINGS.dropMargin) ||
			inRect(this.o.arkabeher, x, y, SETTINGS.dropMargin))) {
			this.startSpoonPourTween();
			return;
		}
		// An invalid drop lowers at the release point, then returns to its resting place.
		this.reverseDrag(drag);
	}

	startSpoonDip(salt, dish) {
		this.stage = "dipping";
		this.spoonReadyForBeaker = false;
		still(this.spoon, "Default", 30);
		this.spoon.moveToTop();
		this.spoonMotion = {
			phase: "salt-approach", salt, dish, time: 0,
			fromX: this.spoon.x, fromY: this.spoon.y,
			// Frame 30's bowl is left of the sprite origin. Offset the sprite so
			// the bowl, rather than the handle, reaches the top of the salt pile.
			toX: dish.x + SETTINGS.spoonBowlOffsetX,
			toY: dish.y + SETTINGS.spoonSaltTopOffsetY
		};
	}

	startSpoonPourTween() {
		const beaker = this.o.arkabeher.getBoundingBox();
		const safePourX = this.water.x + 34.5;
		this.stage = "spoon-to-beaker";
		this.water.stopAnimation();
		this.spoon.moveToTop();
		this.spoonMotion = {
			phase: "pour-approach", time: 0,
			fromX: this.spoon.x, fromY: this.spoon.y,
			// The late pouring frames contain a nearly beaker-wide salt pile.
			// Keep that pile centred for both salts so no particle artwork can
			// slide past either inner glass edge.
			toX: safePourX,
			toY: beaker.top - 35,
			pourY: this.water.y - 167
		};
	}

	startPour(x = this.water.x + 34.5, y = this.water.y - 167) {
		this.stage = "pouring";
		this.water.stopAnimation();
		still(this.spoon, "dokulme");
		this.spoon.setPosition(x, y);
		this.spoon.animationSpeed = SETTINGS.pourFPS;
		this.spoon.startAnimation("beginning");
	}

	finishPour() {
		// Advance first: no optional visual operation may leave the experiment
		// stuck on the final pouring frame.
		if (this.stage !== "pouring") return;
		this.stage = "thermometer";
		still(this.spoon, "son");
		// The pouring position follows the user's drop point, but the remaining
		// salt must always settle in the middle of the beaker instead of sliding.
		this.spoon.setPosition(this.water.x + 34.5, this.water.y - 167);
		this.spoon.opacity = 1;
		this.spoon.moveAdjacentToInstance(this.o["önbeherdikkat"], false);
		// 'son' contains only the salt remaining in the beaker. Creating a second
		// Sprite here is unnecessary and can interrupt this transition in C3.
		this.restingSpoon = null;
		this.renderOutlines();
	}

	startThermometerInsertion() {
		if (this.thermometerInserting || this.thermometerPlaced) return;
		this.thermometerPending = false;
		this.thermometerInserting = true;
		this.thermometerPhase = "approach";
		this.thermometerInsertTime = 0;
		still(this.thermometer, "derece", this.temperatureFrame());
		this.thermometerApproachX = this.thermometer.x;
		this.thermometerApproachY = this.thermometer.y;
		// Keep the proven final placement; only lift a little higher before descent.
		this.thermometerFinalX = this.water.x - 149;
		this.thermometerFinalY = this.water.y - 150;
		this.thermometerTopX = this.thermometerFinalX;
		this.thermometerTopY = this.thermometerFinalY - 280;
		this.thermometer.moveToTop();
	}

	startThermometerDescent() {
		this.thermometerPhase = "descent";
		this.thermometerInsertTime = 0;
		this.thermometer.setPosition(this.thermometerTopX, this.thermometerTopY);
		// Pass behind only the front glass after reaching the top of the beaker.
		this.thermometer.moveAdjacentToInstance(this.o["önbeherdikkat"], false);
	}

	finishThermometerInsertion() {
		this.thermometerInserting = false;
		this.thermometerPhase = null;
		this.thermometerPlaced = true;
		this.thermometer.setPosition(this.thermometerFinalX, this.thermometerFinalY);
		this.o["gösterge"].setPosition(this.thermometer.x - 155, this.thermometer.y - 180);
		this.readout.setPosition(this.thermometer.x - 245, this.thermometer.y - 209);
		this.o["gösterge"].isVisible = true;
		this.readout.isVisible = true;
		this.updateTemperatureDisplay();
		if (this.stage === "thermometer") this.stage = "ready";
		this.renderOutlines();
	}

	temperatureFrame() {
		// 'derece' frame 15 is room temperature. Exothermic reactions move
		// towards frame 0; endothermic reactions move towards frame 30.
		if (this.temperature >= 25)
			return Math.round(15 * (50 - clamp(this.temperature, 25, 50)) / 25);
		return Math.round(15 + 15 * (25 - clamp(this.temperature, 12, 25)) / 13);
	}

	updateTemperatureDisplay() {
		this.readout.text = `${this.temperature.toFixed(1).replace(".", ",")} °C`;
		if (this.thermometerPlaced) this.thermometer.animationFrame = this.temperatureFrame();
	}

	toggleStirrer() {
		if (!["ready", "mixing", "complete"].includes(this.stage)) return;
		this.playSound("click");
		this.stirring = !this.stirring;
		this.o.OFFbt.animationFrame = this.stirring ? 1 : 0;
		this.o.karistiriciacik.animationFrame = this.stirring ? 1 : 0;
		if (this.stirring) {
			if (this.stage === "ready") {
				this.stage = "mixing";
				this.conceptHint = true;
				this.answerHint = !this.answered;
			}
			// Frames are advanced from the dissolution progress in tick().
			// Speed zero prevents Construct from looping independently.
			this.water.animationSpeed = 0;
			this.water.startAnimation();
		} else this.water.stopAnimation();
		this.renderOutlines();
	}

	chooseConcept(selection) {
		if (!this.unlocked || !COLORS[selection]) return;
		this.playSound("click");
		this.selection = selection;
		this.conceptHint = false; // Any one choice acknowledges all three white hints.
		for (const [key, name] of Object.entries(BUTTONS)) this.o[name].animationFrame = key === selection ? 1 : 0;
		this.renderOutlines();
	}

	answer(name) {
		if (!["mixing", "complete"].includes(this.stage) || this.answered) return;
		this.answered = true;
		this.playSound("click");
		this.answerHint = false;
		const correct = this.salt === "nh4cl" ? "Endotermikbt" : "Ekzotermik";
		this.o.Ekzotermik.animationFrame = 0;
		this.o.Endotermikbt.animationFrame = 0;
		this.o[name].animationFrame = name === correct ? 2 : 1;
		this.playSound(name === correct ? "true" : "false");
	}

	playSound(name) {
		const functionName = {
			click: "PlayClickSound",
			true: "PlayTrueSound",
			false: "PlayFalseSound"
		}[name];
		if (functionName && typeof this.runtime.callFunction === "function")
			this.runtime.callFunction(functionName);
	}

	tick(dt) {
		// Ignore elapsed background-tab time; use Construct's scaled game time.
		dt = clamp(dt || 0, 0, 0.1);
		this.time += dt;
		if (this.returning?.phase === "reverse" &&
			(this.returning.instance.animationName !== "Default" ||
			this.returning.instance.animationFrame <= 0)) this.startReturnTween();
		if (this.returning?.phase === "tween") {
			const returning = this.returning;
			returning.returnTime += dt;
			const duration = returning.kind === "spoon" ? SETTINGS.spoonReturnSeconds : SETTINGS.returnSeconds;
			const p = clamp(returning.returnTime / duration, 0, 1);
			const eased = smooth(p);
			returning.instance.setPosition(
				returning.returnFromX + (returning.startX - returning.returnFromX) * eased,
				returning.returnFromY + (returning.startY - returning.returnFromY) * eased);
			if (p === 1) {
				returning.instance.setPosition(returning.startX, returning.startY);
				if (returning.kind === "thermometer")
					returning.instance.moveAdjacentToInstance(this.o["önbeherdikkat"], false);
				this.returning = null;
			}
		}
		if (this.spoonMotion) {
			const motion = this.spoonMotion;
			motion.time += dt;
			const duration = motion.phase === "pour-approach" ? SETTINGS.spoonPourApproachSeconds :
				motion.phase === "salt-approach" ? SETTINGS.spoonSaltApproachSeconds : SETTINGS.spoonDipSeconds;
			const p = clamp(motion.time / duration, 0, 1);
			const eased = smooth(p);
			this.spoon.setPosition(motion.fromX + (motion.toX - motion.fromX) * eased,
				motion.fromY + (motion.toY - motion.fromY) * eased);
			if (p === 1 && motion.phase === "salt-approach") {
				motion.phase = "dip-down";
				motion.time = 0;
				motion.fromX = motion.toX;
				motion.fromY = motion.toY;
				motion.toY = motion.dish.y + SETTINGS.spoonSaltTopOffsetY + SETTINGS.spoonDipDepth;
			} else if (p === 1 && motion.phase === "dip-down") {
				motion.phase = "dip-up";
				motion.time = 0;
				motion.fromX = motion.toX;
				motion.fromY = motion.toY;
				motion.toX = motion.dish.x + SETTINGS.spoonBowlOffsetX;
				motion.toY = motion.dish.y + SETTINGS.spoonLoadedOffsetY;
			} else if (p === 1 && motion.phase === "dip-up") {
				this.salt = motion.salt;
				still(this.spoon, motion.salt);
				this.spoon.setPosition(motion.toX, motion.toY);
				this.spoonMotion = null;
				this.stage = "loaded";
			} else if (p === 1 && motion.phase === "pour-approach") {
				const targetX = motion.toX;
				const targetY = motion.pourY;
				this.spoonMotion = null;
				this.startPour(targetX, targetY);
			}
		}
		// Animation-end events can be skipped if a tab loses focus at the last
		// frame. Frame checks keep both required transitions deterministic.
		if (this.stage === "pouring" && String(this.spoon.animationName).toLowerCase() === "dokulme" &&
			this.spoon.animationFrame >= 59) this.finishPour();
		if (this.thermometerPending && this.thermometer.animationName === "Default" &&
			this.thermometer.animationFrame >= 30) this.startThermometerInsertion();
		if (this.thermometerInserting) {
			this.thermometerInsertTime += dt;
			if (this.thermometerPhase === "approach") {
				const p = clamp(this.thermometerInsertTime / SETTINGS.thermometerApproachSeconds, 0, 1);
				const eased = smooth(p);
				this.thermometer.setPosition(
					this.thermometerApproachX + (this.thermometerTopX - this.thermometerApproachX) * eased,
					this.thermometerApproachY + (this.thermometerTopY - this.thermometerApproachY) * eased);
				if (p === 1) this.startThermometerDescent();
			} else {
				const p = clamp(this.thermometerInsertTime / SETTINGS.thermometerInsertSeconds, 0, 1);
				this.thermometer.setPosition(this.thermometerFinalX,
					this.thermometerTopY + (this.thermometerFinalY - this.thermometerTopY) * smooth(p));
				if (p === 1) this.finishThermometerInsertion();
			}
		}
		if (this.stirring) {
			if (this.stage === "mixing") {
				this.mixTime += dt;
				const config = SETTINGS[this.salt];
				const progress = clamp(this.mixTime / config.seconds, 0, 1);
				const dissolved = smooth(progress);
				this.spoon.opacity = 1 - dissolved;
				this.water.animationFrame = Math.round(dissolved * SETTINGS.waterLastFrame);
				this.temperature = 25 + (config.temperature - 25) * dissolved;
				// Frame 0 has the highest column, frame 30 the lowest; never use blank 31.
				this.updateTemperatureDisplay();
				if (progress === 1) {
					this.stage = "complete";
					this.spoon.isVisible = false;
					this.water.stopAnimation();
					this.answerHint = !this.answered;
				}
			}
		}
		this.renderOutlines();
	}

	outline(instance, color = null, width = 5) {
		if (!instance) return;
		const effect = instance.effects.BetterOutline;
		if (!effect) return;
		const key = color ? `${color.join(",")}:${width}` : "off";
		if (this.outlineCache.get(instance) === key) return;
		this.outlineCache.set(instance, key);
		if (color) {
			effect.setParameter(0, color);
			effect.setParameter(1, width);
		}
		effect.isActive = Boolean(color);
	}

	renderOutlines() {
		const wanted = new Map();
		const color = COLORS[this.selection];
		if (color) {
			const width = this.selection === "system" ? 9 : 5;
			const mark = instance => wanted.set(instance, { color, width });
			// System is the solution and its container.
			if (this.selection === "system" || this.selection === "universe") {
				mark(this.water);
				mark(this.o.arkabeher);
				mark(this.o["önbeherdikkat"]);
				if (this.spoon.isVisible && this.spoon.opacity > 0) mark(this.spoon);
			}
			// Surroundings deliberately excludes both the liquid and the beaker.
			if (this.selection === "surroundings" || this.selection === "universe") {
				for (const name of ["img2", "karistiriciacik", "NH4Cl", "CH3COONa",
					"paremetre", "OFFbt", "gösterge"])
					mark(this.o[name]);
				if (this.restingSpoon) mark(this.restingSpoon);
			}
		}
		const lit = this.time % SETTINGS.blinkPeriod < SETTINGS.blinkPeriod * 0.55;
		if (lit) {
			const hint = instance => wanted.set(instance, { color: WHITE, width: 5 });
			if (this.stage === "spoon") hint(this.spoon);
			if (this.stage === "salt") {
				hint(this.o.NH4Cl);
				hint(this.o.CH3COONa);
			}
			if (this.stage === "loaded") {
				hint(this.spoonReadyForBeaker ? this.o["önbeherdikkat"] : this.spoon);
			}
			if (this.stage === "thermometer") {
				hint(this.thermometerTargetHint ? this.o["önbeherdikkat"] : this.thermometer);
			}
			if (this.stage === "ready") hint(this.o.OFFbt);
			if (this.conceptHint) for (const name of Object.values(BUTTONS)) hint(this.o[name]);
			if (this.answerHint) {
				hint(this.o.Ekzotermik);
				hint(this.o.Endotermikbt);
			}
		}
		for (const instance of [...Object.values(this.o), this.restingSpoon]) {
			const style = wanted.get(instance);
			this.outline(instance, style?.color, style?.width);
		}
		for (const line of this.tableLines) {
			line.isVisible = Boolean(color && this.selection !== "system");
			if (color) line.colorRgb = color;
		}
	}

	dispose() {
		this.cancelDrag();
		this.spoon.removeEventListener("animationend", this.onPourEnd);
		this.thermometer.removeEventListener("animationend", this.onThermometerLiftEnd);
		this.outlineCache.clear();
	}
}
