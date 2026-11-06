"""Preferred subject labels, aliases and parents shared by every classification path.

This is a small application taxonomy, not a fuzzy merge of equally named nodes.
Unknown user topics remain distinct; only declared aliases share a concept.
"""
import re
import unicodedata


CONCEPTS = [
    (('Technology',), ('tech',)),
    (('Technology', 'Programming'), ('development', 'software development', 'software engineering', 'coding')),
    (('Technology', 'Programming', 'Web Development'), ('frontend', 'front end', 'frontend development', 'web dev')),
    (('Technology', 'Programming', 'Backend Development'), ('backend', 'back end', 'backend engineering')),
    (('Technology', 'Programming', 'Algorithms'), ('data structures and algorithms', 'dsa')),
    (('Technology', 'Programming', 'Cybersecurity'), ('cyber security', 'security engineering')),
    (('Technology', 'Programming', 'Open Source'), ('foss', 'open source software')),
    (('Technology', 'AI & Machine Learning'), ('artificial intelligence', 'artificial intelligence & machine learning', 'artificial intelligence and machine learning', 'ai', 'ml', 'ai ml', 'ai and ml', 'ai & learning', 'machine learning', 'deep learning')),
    (('Technology', 'AI & Machine Learning', 'Transformers'), ('transformer models',)),
    (('Technology', 'AI & Machine Learning', 'Diffusion Models'), ('diffusion',)),
    (('Technology', 'AI & Machine Learning', 'Retrieval & Embeddings'), ('rag', 'retrieval augmented generation', 'embeddings', 'vector search')),
    (('Technology', 'Hardware & Computing'), ('hardware & tech', 'hardware', 'computer hardware')),
    (('Technology', 'Hardware & Computing', 'Automotive & Cars'), ('automotive', 'cars')),
    (('Creative Work',), ()),
    (('Creative Work', 'Design'), ('design & ui ux', 'visual design')),
    (('Creative Work', 'Design', 'Typography'), ('type design',)),
    (('Creative Work', 'Design', 'Interface Design'), ('ui ux', 'ui design', 'ux design', 'user interface design')),
    (('Creative Work', 'Design', 'CAD & 3D Design'), ('cad', '3d design', 'computer aided design')),
    (('Creative Work', 'Video Editing'), ('editing', 'post production', 'film editing')),
    (('Creative Work', 'Video Editing', 'Motion Design'), ('motion graphics', 'motion designers', 'animation')),
    (('Entertainment',), ('entertainment & video',)),
    (('Entertainment', 'Movies & TV'), ('movies', 'movie trailers', 'television', 'tv shows')),
    (('Entertainment', 'Gaming'), ('video games', 'games')),
    (('Hobbies',), ('hobby', 'personal interests')),
    (('Hobbies', 'Music & Audio'), ('music', 'audio', 'musical instruments')),
    (('Hobbies', 'Cooking'), ('food', 'recipes')),
    (('Hobbies', 'Fitness & Wellbeing'), ('fitness', 'workouts', 'wellbeing')),
    (('Hobbies', 'Personal Growth'), ('self improvement', 'personal development')),
    (('People & Media',), ()),
    (('People & Media', 'News & Current Affairs'), ('news', 'news & media', 'current affairs')),
    (('People & Media', 'Social Media'), ('social media & community', 'content creation', 'creator economy')),
    (('Work & Life',), ()),
    (('Work & Life', 'Productivity & Tools'), ('productivity', 'productivity tools')),
    (('Learning',), ('academics & science', 'academics', 'education')),
    (('Learning', 'Mathematics'), ('math', 'maths')),
    (('Learning', 'Science'), ('scientific learning',)),
    (('Business', 'Finance'), ('investing', 'financial markets')),
    (('Business',), ('finance & business',)),
    (('Building & Opportunities',), ()),
    (('Building & Opportunities', 'Hackathons'), ('hackathon',)),
    (('Building & Opportunities', 'Opportunities'), ('open opportunities',)),
    (('Needs a Topic',), ()),
]


def _key(label: str) -> str:
    return re.sub(r'[^\w]+', ' ', unicodedata.normalize('NFKC', label).casefold()).strip()


ALIASES = {}
for path, aliases in CONCEPTS:
    for label in (path[-1], *aliases):
        key = _key(label)
        if key in ALIASES and ALIASES[key] != path:
            raise ValueError(f'Ambiguous subject alias: {label}')
        ALIASES[key] = path


def canonical_subject_path(label: str) -> tuple[str, ...] | None:
    """Resolve declared labels (including old breadcrumb labels) to one parent path."""
    normalized = _key(label)
    if normalized in ALIASES:
        return ALIASES[normalized]
    parts = re.split(r'\s*(?:>|›|→)\s*', label)
    return ALIASES.get(_key(parts[-1])) if len(parts) > 1 else None
