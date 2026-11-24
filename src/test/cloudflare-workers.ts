export class DurableObject<Env = unknown> {
	protected readonly ctx: DurableObjectState;
	protected readonly env: Env;

	constructor(ctx: DurableObjectState, env: Env) {
		this.ctx = ctx;
		this.env = env;
	}
}
