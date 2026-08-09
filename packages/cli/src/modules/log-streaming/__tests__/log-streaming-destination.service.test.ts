import type { Logger } from '@n8n/backend-common';
import type { OutboundHttp } from '@n8n/backend-network';
import { mock } from 'vitest-mock-extended';

import type { EventMessageTypes } from '@/eventbus/event-message-classes';
import type { EventMessageConfirmSource } from '@/eventbus/event-message-classes/event-message-confirm';
import { EventMessageGeneric } from '@/eventbus/event-message-classes/event-message-generic';
import type { MessageEventBus } from '@/eventbus/message-event-bus/message-event-bus';

import type { EventDestinationsRepository } from '../database/repositories/event-destination.repository';
import type { MessageEventBusDestination } from '../destinations/message-event-bus-destination';
import { LogStreamingDestinationService } from '../log-streaming-destination.service';

const logger = mock<Logger>();
const eventBus = mock<MessageEventBus>();
const repository = mock<EventDestinationsRepository>();
const outboundHttp = mock<OutboundHttp>();

const makeDestination = (id: string, label = id) => {
	const destination = mock<MessageEventBusDestination>({ id, label, enabled: true });
	destination.hasSubscribedToEvent.mockReturnValue(true);
	destination.receiveFromEventBus.mockResolvedValue(true);
	destination.serialize.mockReturnValue({ id, label });
	destination.close.mockResolvedValue(undefined);
	return destination;
};

const makeMessage = () => new EventMessageGeneric({ eventName: 'n8n.workflow.success' });

describe('LogStreamingDestinationService', () => {
	let service: LogStreamingDestinationService;

	const handleMessage = async (
		msg: EventMessageGeneric,
		confirmCallback: ReturnType<typeof vi.fn>,
	) => {
		await service['handleMessage'](
			msg,
			confirmCallback as (message: EventMessageTypes, source: EventMessageConfirmSource) => void,
		);
	};

	beforeEach(() => {
		vi.clearAllMocks();
		repository.saveDestination.mockResolvedValue(undefined);
		repository.deleteById.mockResolvedValue(undefined);
		service = new LogStreamingDestinationService(logger, eventBus, repository, outboundHttp);
	});

	describe('acknowledgment tracking', () => {
		it('confirms immediately when no destination applies', async () => {
			const confirm = vi.fn();
			await handleMessage(makeMessage(), confirm);
			expect(confirm).toHaveBeenCalledWith(expect.anything(), { id: '0', name: 'eventBus' });
		});

		it('does not confirm while any applicable destination has failed', async () => {
			const destA = makeDestination('a');
			const destB = makeDestination('b');
			destB.receiveFromEventBus.mockResolvedValue(false);
			await service.addDestination(destA);
			await service.addDestination(destB);

			const confirm = vi.fn();
			await handleMessage(makeMessage(), confirm);

			expect(destA.receiveFromEventBus).toHaveBeenCalledTimes(1);
			expect(destB.receiveFromEventBus).toHaveBeenCalledTimes(1);
			expect(confirm).not.toHaveBeenCalled();
		});

		it('on retry, skips already-delivered destinations and re-attempts only failed ones', async () => {
			const destA = makeDestination('a');
			const destB = makeDestination('b');
			destB.receiveFromEventBus.mockResolvedValueOnce(false);
			await service.addDestination(destA);
			await service.addDestination(destB);

			const confirm = vi.fn();
			const msg = makeMessage();
			await handleMessage(msg, confirm); // A delivers, B fails → unconfirmed
			await handleMessage(msg, confirm); // retry: only B is attempted, succeeds

			expect(destA.receiveFromEventBus).toHaveBeenCalledTimes(1);
			expect(destB.receiveFromEventBus).toHaveBeenCalledTimes(2);
			expect(confirm).toHaveBeenCalledWith(msg, { id: 'a', name: 'a' });
			expect(confirm).toHaveBeenCalledWith(msg, { id: 'b', name: 'b' });
		});

		it('confirms once every applicable destination has delivered', async () => {
			const destA = makeDestination('a');
			const destB = makeDestination('b');
			await service.addDestination(destA);
			await service.addDestination(destB);

			const confirm = vi.fn();
			await handleMessage(makeMessage(), confirm);

			expect(confirm).toHaveBeenCalledTimes(2);
		});

		it('does not start a duplicate send while a delivery is still in flight', async () => {
			const destA = makeDestination('a');
			let resolveDelivery!: (delivered: boolean) => void;
			destA.receiveFromEventBus.mockImplementation(
				async () => await new Promise<boolean>((resolve) => (resolveDelivery = resolve)),
			);
			await service.addDestination(destA);

			const confirm = vi.fn();
			const msg = makeMessage();
			const firstWave = handleMessage(msg, confirm);
			await handleMessage(msg, confirm); // bus retry while the first attempt is in flight

			expect(destA.receiveFromEventBus).toHaveBeenCalledTimes(1);
			resolveDelivery(true);
			await firstWave;
			expect(confirm).toHaveBeenCalledWith(msg, { id: 'a', name: 'a' });
		});
	});

	describe('persist-before-swap ordering', () => {
		it('keeps the previous destination active when persisting an update fails', async () => {
			const previous = makeDestination('same-id');
			await service.addDestination(previous);

			const replacement = makeDestination('same-id');
			repository.saveDestination.mockRejectedValueOnce(new Error('db down'));

			await expect(service.addDestination(replacement)).rejects.toThrow('db down');
			expect(previous.close).not.toHaveBeenCalled();
			// the previous destination still handles deliveries
			const confirm = vi.fn();
			await handleMessage(makeMessage(), confirm);
			expect(previous.receiveFromEventBus).toHaveBeenCalledTimes(1);
			expect(replacement.receiveFromEventBus).not.toHaveBeenCalled();
		});

		it('closes the replaced destination only after persistence succeeded', async () => {
			const order: string[] = [];
			repository.saveDestination.mockImplementation(async () => {
				order.push('persist');
			});
			const previous = makeDestination('same-id');
			await service.addDestination(previous);
			previous.close.mockImplementation(async () => {
				order.push('close-previous');
			});

			await service.addDestination(makeDestination('same-id'));
			expect(order).toEqual(['persist', 'persist', 'close-previous']);
		});

		it('keeps the destination active when deleting the row fails', async () => {
			const destination = makeDestination('doomed');
			await service.addDestination(destination);
			repository.deleteById.mockRejectedValueOnce(new Error('db down'));

			await expect(service.removeDestination('doomed')).rejects.toThrow('db down');
			expect(destination.close).not.toHaveBeenCalled();
			expect(await service.findDestination('doomed')).toHaveLength(1);
		});

		it('removes runtime state and closes the destination after the row is deleted', async () => {
			const destination = makeDestination('doomed');
			await service.addDestination(destination);

			await service.removeDestination('doomed');
			expect(repository.deleteById).toHaveBeenCalledWith('doomed');
			expect(destination.close).toHaveBeenCalledTimes(1);
			expect(await service.findDestination('doomed')).toHaveLength(0);
		});
	});

	describe('findDestination redaction', () => {
		it('serializes with redaction by default and without it when opted out', async () => {
			const destination = makeDestination('a');
			await service.addDestination(destination);
			destination.serialize.mockClear();

			await service.findDestination('a');
			expect(destination.serialize).toHaveBeenCalledWith({ redactSecrets: true });

			await service.findDestination('a', { redactSecrets: false });
			expect(destination.serialize).toHaveBeenCalledWith({ redactSecrets: false });
		});
	});
});
