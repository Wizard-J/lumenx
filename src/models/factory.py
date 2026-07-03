from .wanx import WanxModel
from ..utils import get_logger

logger = get_logger(__name__)

class ModelFactory:
    @staticmethod
    def create_model(config):
        model_name = config.get('model.name')
        if model_name == 'wanx':
            return WanxModel(config.get('model'))
        elif model_name in ('kling', 'kling-v3'):
            from .kling import KlingModel
            return KlingModel(config.get('model') or {})
        elif model_name in ('vidu', 'viduq3-pro', 'viduq3-turbo'):
            from .vidu import ViduModel
            return ViduModel(config.get('model') or {})
        elif model_name == 'openai_image':
            from .openai_image import OpenAIImageModel
            return OpenAIImageModel(config.get('model') or {})
        elif model_name == 'openai_video':
            from .openai_video import OpenAIVideoModel
            return OpenAIVideoModel(config.get('model') or {})
        elif model_name == 'agnes_video':
            from .agnes_video import AgnesVideoModel
            return AgnesVideoModel(config.get('model') or {})
        elif model_name == 'seedance':
            from .seedance import SeedanceVideoModel
            return SeedanceVideoModel(config.get('model') or {})
        else:
            raise ValueError(f"Unknown model: {model_name}")
